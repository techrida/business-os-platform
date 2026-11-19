// The in-memory role → permission → scope table for each tenant, and the merge that turns a user's
// roles and level into `Principal.grants`. Serves the NFR "< 5 ms per decision" (P1 plan §1, k-authz): a
// request reads its grants from memory, and the database is touched at most once per tenant every
// 5 s to check that the rows are still current (risk R11, staleness across api instances).
// What a role may do is company policy, so `role_permissions`, `role_permission_levels` and `authz_versions`
// are tenant-scoped and every entity of a tenant shares one entry (ADR 0027 §7). Membership narrows the roles
// per entity, and gives the level, before they reach `grantsFor` (the tenancy interceptor).
import {
  ACCESS_LEVEL_RANK,
  ACCESS_LEVELS,
  ACCESS_SCOPE_RANK,
  type AccessLevel,
  type AccessScope,
  DEFAULT_ROLE_PERMISSION_LEVELS,
  DEFAULT_ROLE_PERMISSIONS,
  type LevelGrant,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
} from '@bos/contracts';
import { authzVersions } from '@bos/db';
import { Inject, Injectable, Optional } from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';

import { DB, type Db } from '../db/db.module';

/** How long a confirmed `authz_versions.version` is trusted before it is read again (R11). */
export const VERSION_CHECK_TTL_MS = 5_000;

/** Milliseconds since some fixed point. Injected so tests can move time forward. */
export type Clock = () => number;
/** Nest token for the clock. Optional: without a provider the cache uses `Date.now`. */
export const AUTHZ_CLOCK = Symbol('AUTHZ_CLOCK');

/**
 * Narrow to wide (`ACCESS_SCOPE_RANK`: assigned < own < department < customer_org < all). When two roles, or a
 * role and a level row, grant the same permission, the higher rank wins.
 *
 * The first three are nested (spec A2, review R1): `department` reaches my own records too, and `own` on a read
 * permission with record reach covers what I am assigned. `all` sits above `customer_org` because it reaches
 * everything `customer_org` does, for every org kind (see `can.ts`). `customer_org` against `department` is a
 * policy choice (no role holds both for one permission): `Principal.grants` holds one scope per permission.
 * A scope string the contracts do not know ranks below every real one, so it never displaces a grant.
 */
const SCOPE_RANK: Readonly<Record<string, number | undefined>> = ACCESS_SCOPE_RANK;
const rankOf = (scope: string): number => SCOPE_RANK[scope] ?? -1;

/** Seniority of a level; a level string this build does not know is above every member, so its row never applies. */
const LEVEL_RANK: Readonly<Record<string, number | undefined>> = ACCESS_LEVEL_RANK;
const levelRankOf = (level: string): number => LEVEL_RANK[level] ?? Number.POSITIVE_INFINITY;

type RoleGrants = ReadonlyMap<Permission, AccessScope>;

/**
 * One role's grants as a member of each level sees them: `staff` is the base grant, the others
 * widened by level rows.
 */
type LeveledGrants = Readonly<Record<AccessLevel, RoleGrants>>;

/** One tenant's rows, and the version they were read at. */
interface TenantEntry {
  /** `authz_versions.version` read just before the rows; null when the tenant has no version row yet. */
  version: number | null;
  /** Clock time the version was last confirmed against the database. */
  checkedAt: number;
  byRole: ReadonlyMap<string, LeveledGrants>;
}

const EMPTY: RoleGrants = new Map();
const ROLE_KEY_SET: ReadonlySet<string> = new Set(ROLE_KEYS);

/** A `role_permission_levels` row, or a default one. */
interface LevelRow {
  roleKey: string;
  permission: Permission;
  minLevel: AccessLevel;
  scope: AccessScope;
}

/**
 * Applies level rows on top of each role's base grants. A row reaches every level at or above its `minLevel`, and
 * a member gets the wider of the base grant and the most senior row at or below their level (K3, the same rule as
 * `effectiveScope` in the contracts tests), so a level only ever widens (D51, review "the level switch only
 * widens") and a head with no head row of their own keeps the manager row. A row for a permission the role does
 * not hold at all is ignored: a level widens an existing grant, it never creates access (the same rule as Check a
 * person, `effectiveScopeForUser`).
 */
function withLevels(
  base: ReadonlyMap<string, RoleGrants>,
  levelRows: readonly LevelRow[],
): ReadonlyMap<string, LeveledGrants> {
  const rowsByRole = new Map<string, LevelRow[]>();
  for (const row of levelRows) {
    const list = rowsByRole.get(row.roleKey) ?? [];
    list.push(row);
    rowsByRole.set(row.roleKey, list);
  }
  const out = new Map<string, LeveledGrants>();
  for (const [role, staff] of base) {
    const rows = rowsByRole.get(role) ?? [];
    const leveled = { staff } as Record<AccessLevel, RoleGrants>;
    for (const level of ACCESS_LEVELS) {
      if (level === 'staff') continue;
      // Shared, not copied, when no row applies: the warm path then reads the very same map for every level.
      const applying = rows.filter(
        (r) => levelRankOf(r.minLevel) <= levelRankOf(level) && staff.has(r.permission),
      );
      if (applying.length === 0) {
        leveled[level] = staff;
        continue;
      }
      const senior = new Map<Permission, LevelRow>();
      for (const r of applying) {
        const held = senior.get(r.permission);
        if (held === undefined || levelRankOf(r.minLevel) > levelRankOf(held.minLevel)) {
          senior.set(r.permission, r);
        }
      }
      const widened = new Map(staff);
      for (const [permission, r] of senior) {
        const current = widened.get(permission);
        if (current !== undefined && rankOf(r.scope) > rankOf(current)) {
          widened.set(permission, r.scope);
        }
      }
      leveled[level] = widened;
    }
    out.set(role, leveled);
  }
  return out;
}

/**
 * The code default level rows (`DEFAULT_ROLE_PERMISSION_LEVELS`), used while a tenant has never had level rows of
 * its own. They are applied to the tenant's live base grants, so a role the Founder took a grant from gets no level
 * row for it either.
 */
const DEFAULT_LEVEL_ROWS: readonly LevelRow[] = Object.entries(
  DEFAULT_ROLE_PERMISSION_LEVELS,
).flatMap(([roleKey, rows]) =>
  (rows as readonly LevelGrant[]).map((r) => ({
    roleKey,
    permission: r.permission,
    minLevel: r.minLevel,
    scope: r.scope,
  })),
);

/**
 * The fallback base table. The seed copies `DEFAULT_ROLE_PERMISSIONS` into `app.role_permissions` for every
 * tenant and bumps `authz_versions`, so in a seeded system the rows are the truth and this is only used for a
 * tenant that was never seeded (no rows and no version row). The seed must bump `authz_versions` when it inserts
 * the rows, or a cache that already loaded the defaults keeps them.
 */
const DEFAULT_BASE: ReadonlyMap<string, RoleGrants> = new Map(
  Object.entries(DEFAULT_ROLE_PERMISSIONS).map(([role, grants]) => [
    role,
    new Map(Object.entries(grants) as [Permission, AccessScope][]),
  ]),
);

/** A tenant that was never seeded: both default tables, built once. */
const DEFAULT_BY_ROLE: ReadonlyMap<string, LeveledGrants> = withLevels(
  DEFAULT_BASE,
  DEFAULT_LEVEL_ROWS,
);

/** One row of the single load query: a base grant, a level grant, or the tenant's materialized flag. */
interface LoadRow {
  kind: 'base' | 'level' | 'flag';
  roleKey: string | null;
  permission: string | null;
  minLevel: string | null;
  scope: string | null;
  [key: string]: unknown;
}

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
   * The union of what `roles` grant in this tenant to a member of `level`, with the widest scope per permission.
   * A role the tenant has no rows for grants nothing (once a tenant has rows, the table is the whole truth).
   *
   * `level` is the membership's level in the acting entity; pass `staff` (the default) for a caller with no
   * department, as Check a person does: a level widens a grant to the department, and without one there is
   * nothing to widen to.
   *
   * `_organizationId` (the acting entity) does not change the answer: the rows are tenant policy and
   * `roles` are already the effective roles in that entity. It stays in the signature so callers
   * keep passing the full request scope.
   */
  async grantsFor(
    tenantId: string,
    _organizationId: string,
    roles: readonly RoleKey[],
    level: AccessLevel = 'staff',
  ): Promise<ReadonlyMap<Permission, AccessScope>> {
    const entry = await this.entryFor(tenantId);
    return merge(entry.byRole, roles, level);
  }

  /**
   * The roles whose live base grants in this tenant hold `permission` at any scope, sorted: who to notify or
   * route to "everyone who may do X". The code defaults answer only for a tenant that was never seeded, like
   * `grantsFor`. Level rows are not consulted: a level only widens a grant the role already has.
   */
  async rolesGranting(tenantId: string, permission: Permission): Promise<RoleKey[]> {
    const entry = await this.entryFor(tenantId);
    const roles: RoleKey[] = [];
    for (const [role, grants] of entry.byRole) {
      if (ROLE_KEY_SET.has(role) && grants.staff.has(permission)) roles.push(role as RoleKey);
    }
    return roles.sort();
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

    const byRole = await this.readRows(tenantId, version !== null);
    const loaded: TenantEntry = { version, checkedAt, byRole };
    this.store(key, loaded, generation);
    return loaded;
  }

  private store(key: string, entry: TenantEntry, generation: number): void {
    if ((this.generations.get(key) ?? 0) === generation) this.entries.set(key, entry);
  }

  /** One read on the `(tenant_id)` unique index; null when the tenant has no version row. */
  private async readVersion(tenantId: string): Promise<number | null> {
    const rows = await this.db
      .select({ version: authzVersions.version })
      .from(authzVersions)
      .where(eq(authzVersions.tenantId, tenantId))
      .limit(1);
    return rows[0]?.version ?? null;
  }

  /**
   * The tenant's base rows, level rows and level-rules flag, in one statement so a reload is still one round trip.
   *
   * Which tables count:
   * - Base grants: the `role_permissions` rows. Only a tenant that was never seeded (no rows AND no
   *   `authz_versions` row) gets `DEFAULT_ROLE_PERMISSIONS`. Every policy write bumps the version, so a Founder
   *   who removed every grant keeps an empty policy instead of getting the defaults back.
   * - Level grants: the `role_permission_levels` rows once the tenant has any, or once Access Settings marked the
   *   level rules materialized (`access_revisions.level_rules_materialized`), in which case zero rows means every
   *   level switch was turned off. Otherwise `DEFAULT_ROLE_PERMISSION_LEVELS`. The same rule as Access Settings'
   *   `deriveLevelRules`, so Check a person and the request agree.
   */
  private async readRows(
    tenantId: string,
    hasVersionRow: boolean,
  ): Promise<ReadonlyMap<string, LeveledGrants>> {
    const result = await this.db.execute<LoadRow>(sql`
      SELECT 'base' AS "kind", role_key AS "roleKey", permission, NULL::text AS "minLevel", scope
        FROM app.role_permissions WHERE tenant_id = ${tenantId}
      UNION ALL
      SELECT 'level', role_key, permission, min_level, scope
        FROM app.role_permission_levels WHERE tenant_id = ${tenantId}
      UNION ALL
      SELECT 'flag', NULL, NULL, NULL, level_rules_materialized::text
        FROM app.access_revisions WHERE tenant_id = ${tenantId}
    `);

    const baseRows: LoadRow[] = [];
    const levelRows: LevelRow[] = [];
    let materialized = false;
    for (const row of result.rows) {
      if (row.kind === 'flag') {
        materialized = row.scope === 'true';
      } else if (row.kind === 'level') {
        levelRows.push({
          roleKey: row.roleKey ?? '',
          // Free text in the table, like `permission` below: a string this build does not know never matches.
          permission: row.permission as Permission,
          minLevel: row.minLevel as AccessLevel,
          scope: row.scope as AccessScope,
        });
      } else {
        baseRows.push(row);
      }
    }

    // Never seeded and no level rows of its own: the prebuilt default tables.
    if (baseRows.length === 0 && !hasVersionRow && !materialized && levelRows.length === 0) {
      return DEFAULT_BY_ROLE;
    }

    let base: ReadonlyMap<string, RoleGrants>;
    if (baseRows.length === 0 && !hasVersionRow) {
      base = DEFAULT_BASE;
    } else {
      const byRole = new Map<string, Map<Permission, AccessScope>>();
      for (const row of baseRows) {
        const role = row.roleKey ?? '';
        let grants = byRole.get(role);
        if (grants === undefined) {
          grants = new Map();
          byRole.set(role, grants);
        }
        // `permission` is free text in the table. A string this build does not know is kept; it can
        // never match, because `can()` is only ever asked about a known `Permission`.
        grants.set(row.permission as Permission, row.scope as AccessScope);
      }
      base = byRole;
    }

    const levelRulesStored = materialized || levelRows.length > 0;
    return withLevels(base, levelRulesStored ? levelRows : DEFAULT_LEVEL_ROWS);
  }
}

/** Union of the roles' grants at `level`; the widest scope wins (`rankOf`). */
function merge(
  byRole: ReadonlyMap<string, LeveledGrants>,
  roles: readonly RoleKey[],
  level: AccessLevel,
): RoleGrants {
  // An unknown level string (a bad membership row) gets the base grants, never more.
  const at: AccessLevel = (ACCESS_LEVELS as readonly string[]).includes(level) ? level : 'staff';
  if (roles.length === 1) return byRole.get(roles[0] as RoleKey)?.[at] ?? EMPTY;

  const merged = new Map<Permission, AccessScope>();
  for (const role of roles) {
    for (const [permission, scope] of byRole.get(role)?.[at] ?? EMPTY) {
      const current = merged.get(permission);
      if (current === undefined || rankOf(scope) > rankOf(current)) {
        merged.set(permission, scope);
      }
    }
  }
  return merged;
}
