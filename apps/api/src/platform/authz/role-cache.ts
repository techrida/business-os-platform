// The in-memory role → permission → scope table for each org, and the merge that turns a user's
// roles into `Principal.grants`. Serves the NFR "< 5 ms per decision" (P1 plan §1, k-authz): a
// request reads its grants from memory, and the database is touched at most once per org every 5 s
// to check that the rows are still current (risk R11, staleness across api instances).
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { authzVersions, rolePermissions } from '@bos/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module';

/** How long a confirmed `authz_versions.version` is trusted before it is read again (R11). */
export const VERSION_CHECK_TTL_MS = 5_000;

/** Milliseconds since some fixed point. Injected so tests can move time forward. */
export type Clock = () => number;
/** Nest token for the clock. Optional: without a provider the cache uses `Date.now`. */
export const AUTHZ_CLOCK = Symbol('AUTHZ_CLOCK');

/**
 * Narrow to wide. When two roles grant the same permission, the higher rank wins.
 *
 * `all` sits above `customer_org` because it reaches everything `customer_org` does, for every org
 * kind (see `can.ts`): for staff `customer_org` matches nothing, and for a customer or vendor `all`
 * is "rows my org owns OR rows that name my org as counterparty", which includes the `customer_org`
 * rows. The three lower scopes are not nested like that (a `department` grant does not reach a row I
 * own in another department, and a customer's `customer_org` does not reach rows it owns), so their
 * order is a policy choice: `Principal.grants` holds one scope per permission, and we keep the one
 * that usually reaches further.
 */
const SCOPE_RANK: Readonly<Record<Scope, number>> = {
  own: 0,
  department: 1,
  customer_org: 2,
  all: 3,
};

type RoleGrants = ReadonlyMap<Permission, Scope>;

/** One org's rows, and the version they were read at. */
interface OrgEntry {
  /** `authz_versions.version` read just before the rows; 0 when the org has no version row yet. */
  version: number;
  /** Clock time the version was last confirmed against the database. */
  checkedAt: number;
  byRole: ReadonlyMap<string, RoleGrants>;
}

const EMPTY: RoleGrants = new Map();

/**
 * The fallback table, built once. The seed copies `DEFAULT_ROLE_PERMISSIONS` into
 * `app.role_permissions` for every org, so in a seeded system the rows are the truth and this is
 * only used for a fresh tenant whose org has no rows yet (before the seed runs). The seed must bump
 * `authz_versions` when it inserts the rows, or a cache that already loaded the defaults keeps them.
 */
const DEFAULT_BY_ROLE: ReadonlyMap<string, RoleGrants> = new Map(
  Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([role, grants]) => [
    role,
    new Map(Object.entries(grants) as [Permission, Scope][]),
  ]),
);

const keyOf = (tenantId: string, organizationId: string): string => `${tenantId}:${organizationId}`;

@Injectable()
export class RoleCache {
  private readonly entries = new Map<string, OrgEntry>();
  /** One load at a time per org, so a burst of requests after a bump causes one reload, not many. */
  private readonly inFlight = new Map<string, Promise<OrgEntry>>();
  /**
   * Bumped by `forget()`. A load that started before a `forget()` must not write its (possibly old)
   * rows back, or this instance would keep them for another 5 s despite its own invalidate.
   */
  private readonly generations = new Map<string, number>();
  private readonly clock: Clock;

  constructor(
    @Inject(DB) private readonly db: Db,
    @Optional() @Inject(AUTHZ_CLOCK) clock?: Clock,
  ) {
    this.clock = clock ?? Date.now;
  }

  /**
   * The union of what `roles` grant in this org, with the widest scope per permission. A role the
   * org has no rows for grants nothing (once an org has rows, the table is the whole truth).
   */
  async grantsFor(
    tenantId: string,
    organizationId: string,
    roles: readonly RoleKey[],
  ): Promise<ReadonlyMap<Permission, Scope>> {
    const entry = await this.entryFor(tenantId, organizationId);
    return merge(entry.byRole, roles);
  }

  /** Drops this instance's entry, so the next `grantsFor` reloads. `AuthzService.invalidate` calls it. */
  forget(tenantId: string, organizationId: string): void {
    const key = keyOf(tenantId, organizationId);
    this.entries.delete(key);
    this.inFlight.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private async entryFor(tenantId: string, organizationId: string): Promise<OrgEntry> {
    const key = keyOf(tenantId, organizationId);
    const cached = this.entries.get(key);
    if (cached !== undefined && this.clock() - cached.checkedAt < VERSION_CHECK_TTL_MS) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const generation = this.generations.get(key) ?? 0;
    const load = this.refresh(tenantId, organizationId, cached, generation).finally(() => {
      // Only our own promise: after a forget() a newer load may own the slot.
      if (this.inFlight.get(key) === load) this.inFlight.delete(key);
    });
    this.inFlight.set(key, load);
    return load;
  }

  /**
   * Confirms or reloads one org. Writes the result into `entries` before resolving, unless a
   * `forget()` happened meanwhile (then the caller still gets it, but it is not cached).
   */
  private async refresh(
    tenantId: string,
    organizationId: string,
    cached: OrgEntry | undefined,
    generation: number,
  ): Promise<OrgEntry> {
    const key = keyOf(tenantId, organizationId);
    // The version is read BEFORE the rows. If a change commits in between, we store new rows under
    // the old version and simply reload again at the next check. The other order could store old
    // rows under the new version, and they would stay stale until the next bump.
    const version = await this.readVersion(tenantId, organizationId);
    const checkedAt = this.clock();

    if (cached !== undefined && cached.version === version) {
      const confirmed: OrgEntry = { ...cached, checkedAt };
      this.store(key, confirmed, generation);
      return confirmed;
    }

    const byRole = await this.readRows(tenantId, organizationId);
    const loaded: OrgEntry = { version, checkedAt, byRole };
    this.store(key, loaded, generation);
    return loaded;
  }

  private store(key: string, entry: OrgEntry, generation: number): void {
    if ((this.generations.get(key) ?? 0) === generation) this.entries.set(key, entry);
  }

  /** One read on the `(tenant_id, organization_id)` unique index. */
  private async readVersion(tenantId: string, organizationId: string): Promise<number> {
    const rows = await this.db
      .select({ version: authzVersions.version })
      .from(authzVersions)
      .where(
        and(eq(authzVersions.tenantId, tenantId), eq(authzVersions.organizationId, organizationId)),
      )
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  private async readRows(
    tenantId: string,
    organizationId: string,
  ): Promise<ReadonlyMap<string, RoleGrants>> {
    const rows = await this.db
      .select({
        roleKey: rolePermissions.roleKey,
        permission: rolePermissions.permission,
        scope: rolePermissions.scope,
      })
      .from(rolePermissions)
      .where(
        and(
          eq(rolePermissions.tenantId, tenantId),
          eq(rolePermissions.organizationId, organizationId),
        ),
      );

    // No rows at all: a fresh org before the seed ran (see DEFAULT_BY_ROLE).
    if (rows.length === 0) return DEFAULT_BY_ROLE;

    const byRole = new Map<string, Map<Permission, Scope>>();
    for (const row of rows) {
      let grants = byRole.get(row.roleKey);
      if (grants === undefined) {
        grants = new Map();
        byRole.set(row.roleKey, grants);
      }
      // `permission` is free text in the table. A string this build does not know is kept; it can
      // never match, because `can()` is only ever asked about a known `Permission`.
      grants.set(row.permission as Permission, row.scope);
    }
    return byRole;
  }
}

/** Union of the roles' grants; the widest scope wins (SCOPE_RANK). */
function merge(byRole: ReadonlyMap<string, RoleGrants>, roles: readonly RoleKey[]): RoleGrants {
  if (roles.length === 1) return byRole.get(roles[0] as RoleKey) ?? EMPTY;

  const merged = new Map<Permission, Scope>();
  for (const role of roles) {
    for (const [permission, scope] of byRole.get(role) ?? EMPTY) {
      const current = merged.get(permission);
      if (current === undefined || SCOPE_RANK[scope] > SCOPE_RANK[current]) {
        merged.set(permission, scope);
      }
    }
  }
  return merged;
}
