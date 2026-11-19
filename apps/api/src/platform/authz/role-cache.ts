// The in-memory role → permission → scope table for each tenant, and the merge that turns a user's
// roles into `Principal.grants`. Serves the NFR "< 5 ms per decision" (P1 plan §1, k-authz): a
// request reads its grants from memory, and the database is touched at most once per tenant every
// 5 s to check that the rows are still current (risk R11, staleness across api instances).
// What a role may do is company policy, so `role_permissions` and `authz_versions` are tenant-scoped
// and every entity of a tenant shares one entry (ADR 0027 §7). Membership narrows the roles per
// entity before they reach `grantsFor` (the tenancy interceptor).
import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { authzVersions, rolePermissions } from '@bos/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq } from 'drizzle-orm';

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
 * is the same rows as `customer_org` (rows of the acting entity that name its party, ADR 0027 §5).
 * The three lower scopes are not nested like that (a `department` grant does not reach a row I own
 * in another department), so their order is a policy choice: `Principal.grants` holds one scope per
 * permission, and we keep the one that usually reaches further.
 */
const SCOPE_RANK: Readonly<Record<Scope, number>> = {
  own: 0,
  department: 1,
  customer_org: 2,
  all: 3,
};

type RoleGrants = ReadonlyMap<Permission, Scope>;

/** One tenant's rows, and the version they were read at. */
interface TenantEntry {
  /** `authz_versions.version` read just before the rows; 0 when the tenant has no version row yet. */
  version: number;
  /** Clock time the version was last confirmed against the database. */
  checkedAt: number;
  byRole: ReadonlyMap<string, RoleGrants>;
}

const EMPTY: RoleGrants = new Map();

/**
 * The fallback table, built once. The seed copies `DEFAULT_ROLE_PERMISSIONS` into
 * `app.role_permissions` for every tenant, so in a seeded system the rows are the truth and this is
 * only used for a fresh tenant with no rows yet (before the seed runs). The seed must bump
 * `authz_versions` when it inserts the rows, or a cache that already loaded the defaults keeps them.
 */
const DEFAULT_BY_ROLE: ReadonlyMap<string, RoleGrants> = new Map(
  Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([role, grants]) => [
    role,
    new Map(Object.entries(grants) as [Permission, Scope][]),
  ]),
);

@Injectable()
export class RoleCache {
  /** Keyed by tenant id. */
  private readonly entries = new Map<string, TenantEntry>();
  /** One load at a time per tenant, so a burst of requests after a bump causes one reload, not many. */
  private readonly inFlight = new Map<string, Promise<TenantEntry>>();
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
   * The union of what `roles` grant in this tenant, with the widest scope per permission. A role the
   * tenant has no rows for grants nothing (once a tenant has rows, the table is the whole truth).
   *
   * `_organizationId` (the acting entity) does not change the answer: the rows are tenant policy and
   * `roles` are already the effective roles in that entity. It stays in the signature so callers
   * keep passing the full request scope.
   */
  async grantsFor(
    tenantId: string,
    _organizationId: string,
    roles: readonly RoleKey[],
  ): Promise<ReadonlyMap<Permission, Scope>> {
    const entry = await this.entryFor(tenantId);
    return merge(entry.byRole, roles);
  }

  /**
   * Changes whenever this instance forgets the tenant or sees a newer `authz_versions` row. The tenancy
   * interceptor keys its user cache (department and level of each membership) to it, so a membership
   * change saved with `AuthzService.invalidate` shows on the next request, not after the cache's 60 s.
   */
  async epoch(tenantId: string): Promise<string> {
    const entry = await this.entryFor(tenantId);
    return `${this.generations.get(tenantId) ?? 0}:${entry.version}`;
  }

  /**
   * Drops this instance's entry for the tenant, so the next `grantsFor` reloads, for every entity.
   * `AuthzService.invalidate` calls it. `_organizationId` is ignored, as in `grantsFor`.
   */
  forget(tenantId: string, _organizationId: string): void {
    const key = tenantId;
    this.entries.delete(key);
    this.inFlight.delete(key);
    this.generations.set(key, (this.generations.get(key) ?? 0) + 1);
  }

  private async entryFor(tenantId: string): Promise<TenantEntry> {
    const key = tenantId;
    const cached = this.entries.get(key);
    if (cached !== undefined && this.clock() - cached.checkedAt < VERSION_CHECK_TTL_MS) {
      return cached;
    }

    const pending = this.inFlight.get(key);
    if (pending !== undefined) return pending;

    const generation = this.generations.get(key) ?? 0;
    const load = this.refresh(tenantId, cached, generation).finally(() => {
      // Only our own promise: after a forget() a newer load may own the slot.
      if (this.inFlight.get(key) === load) this.inFlight.delete(key);
    });
    this.inFlight.set(key, load);
    return load;
  }

  /**
   * Confirms or reloads one tenant. Writes the result into `entries` before resolving, unless a
   * `forget()` happened meanwhile (then the caller still gets it, but it is not cached).
   */
  private async refresh(
    tenantId: string,
    cached: TenantEntry | undefined,
    generation: number,
  ): Promise<TenantEntry> {
    const key = tenantId;
    // The version is read BEFORE the rows. If a change commits in between, we store new rows under
    // the old version and simply reload again at the next check. The other order could store old
    // rows under the new version, and they would stay stale until the next bump.
    const version = await this.readVersion(tenantId);
    const checkedAt = this.clock();

    if (cached !== undefined && cached.version === version) {
      const confirmed: TenantEntry = { ...cached, checkedAt };
      this.store(key, confirmed, generation);
      return confirmed;
    }

    const byRole = await this.readRows(tenantId);
    const loaded: TenantEntry = { version, checkedAt, byRole };
    this.store(key, loaded, generation);
    return loaded;
  }

  private store(key: string, entry: TenantEntry, generation: number): void {
    if ((this.generations.get(key) ?? 0) === generation) this.entries.set(key, entry);
  }

  /** One read on the `(tenant_id)` unique index. */
  private async readVersion(tenantId: string): Promise<number> {
    const rows = await this.db
      .select({ version: authzVersions.version })
      .from(authzVersions)
      .where(eq(authzVersions.tenantId, tenantId))
      .limit(1);
    return rows[0]?.version ?? 0;
  }

  private async readRows(tenantId: string): Promise<ReadonlyMap<string, RoleGrants>> {
    const rows = await this.db
      .select({
        roleKey: rolePermissions.roleKey,
        permission: rolePermissions.permission,
        scope: rolePermissions.scope,
      })
      .from(rolePermissions)
      .where(eq(rolePermissions.tenantId, tenantId));

    // No rows at all: a fresh tenant before the seed ran (see DEFAULT_BY_ROLE).
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
