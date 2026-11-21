// The small-team rule (F1-Q11 a). A step that needs a second person (an approver other than the requester, a
// checker other than the maker) cannot be done in a company where nobody else may do it. Then the Founder may do
// it alone, with a reason (`sole_eligible_reason_required`). This file answers the two questions that rule needs:
// who else could do the step right now, and whether the caller is the sole eligible person.
//
// "Could do it" is read the way `live-grants.ts` reads one caller: an active, unlocked user whose mirror roles,
// narrowed by their membership in the acting entity, grant the permission in the role cache. Only the roles come
// from the database; the role -> permission table is the role cache's.
import type { Permission, RoleKey } from '@bos/contracts';
import { type SQL, sql } from 'drizzle-orm';

import type { Db, DbTransaction } from '../db/db.module';
import type { TxScope } from '../db/tx';
import type { UserRow } from '../users/users.store';
import type { LiveGrantTable } from './live-grants';

/** One user of the tenant as the rule sees them, with their mirror roles and their membership in the entity. */
export interface EligibilityCandidate {
  userId: string;
  status: UserRow['status'];
  /** `users.lock_reason` (0125); null = not locked. A locked user's status is 'inactive'. */
  lockReason: string | null;
  /** Mirror roles (`app.user_roles`), not narrowed. */
  roles: readonly RoleKey[];
  /** The membership in `scope.organizationId`; null without one. `roleKeys` null = every mirror role. */
  membership: { roleKeys: readonly string[] | null } | null;
}

/** Reads the tenant's candidates in two queries; `sqlCandidateSource` is the real one. */
export interface EligibilityCandidateSource {
  candidates(q: DbTransaction, scope: TxScope): Promise<EligibilityCandidate[]>;
}

export interface SoleEligibleDeps {
  /** Defaults to `sqlCandidateSource`. */
  candidates?: EligibilityCandidateSource;
  /** The role -> permission table; `RoleCache` satisfies it. */
  grants: LiveGrantTable;
}

export interface OtherEligibleOptions {
  /** The caller and anyone else the step already involves (the requester, the maker). */
  excludeUserIds: readonly string[];
  /** A further rule on the effective roles, such as "not the requester's role"; absent = any roles. */
  roleOk?: (roles: readonly RoleKey[]) => boolean;
  /**
   * True: only members of `scope.organizationId` count, with their roles narrowed by that membership. False: the
   * step is tenant-wide, so membership is not required and the mirror roles count un-narrowed.
   */
  entityScoped: boolean;
}

async function rows<T extends Record<string, unknown>>(q: DbTransaction, query: SQL): Promise<T[]> {
  // Db and DbTransaction share execute(); the cast only picks one of the two identical signatures.
  const result = await (q as unknown as Db).execute<T>(query);
  return result.rows as T[];
}

/**
 * The real source: the tenant's active, unlocked users with their membership in the acting entity (one query), and
 * the tenant's role rows (a second query), joined here. The status and lock filters are repeated by the caller.
 */
export const sqlCandidateSource: EligibilityCandidateSource = {
  async candidates(q, scope) {
    // One after another: both reads share the transaction's single connection.
    const users = await rows<{
      userId: string;
      status: UserRow['status'];
      lockReason: string | null;
      member: boolean;
      roleKeys: string[] | null;
    }>(
      q,
      sql`SELECT u.id AS "userId", u.status, u.lock_reason AS "lockReason",
                 (ue.user_id IS NOT NULL) AS member, ue.role_keys AS "roleKeys"
          FROM app.users u
          LEFT JOIN app.user_entities ue ON ue.tenant_id = u.tenant_id AND ue.user_id = u.id
            AND ue.organization_id = ${scope.organizationId}
          WHERE u.tenant_id = ${scope.tenantId} AND u.status = 'active' AND u.lock_reason IS NULL
          ORDER BY u.id`,
    );
    if (users.length === 0) return [];
    const roleRows = await rows<{ userId: string; role: RoleKey }>(
      q,
      sql`SELECT user_id AS "userId", role_key AS role FROM app.user_roles
          WHERE tenant_id = ${scope.tenantId}`,
    );
    const rolesByUser = new Map<string, RoleKey[]>();
    for (const r of roleRows) {
      const list = rolesByUser.get(r.userId);
      if (list === undefined) rolesByUser.set(r.userId, [r.role]);
      else list.push(r.role);
    }
    return users.map((u) => ({
      userId: u.userId,
      status: u.status,
      lockReason: u.lockReason,
      roles: rolesByUser.get(u.userId) ?? [],
      membership: u.member ? { roleKeys: u.roleKeys } : null,
    }));
  },
};

/**
 * The users other than `excludeUserIds` who could do the step guarded by `permission` in `scope` right now, sorted.
 * Call it inside the step's transaction. Grants are read at the base (staff) level: a level only widens the scope of
 * a grant the role already has, never adds a permission. The role table is read once per distinct role set.
 */
export async function otherEligibleUsers(
  q: DbTransaction,
  deps: SoleEligibleDeps,
  scope: TxScope,
  permission: Permission,
  opts: OtherEligibleOptions,
): Promise<string[]> {
  const source = deps.candidates ?? sqlCandidateSource;
  const excluded = new Set(opts.excludeUserIds.map((id) => id.toLowerCase()));
  const candidates = await source.candidates(q, scope);
  const holds = new Map<string, boolean>();
  const out: string[] = [];
  for (const c of candidates) {
    if (excluded.has(c.userId.toLowerCase())) continue;
    if (c.status !== 'active' || c.lockReason !== null) continue;
    let roles: readonly RoleKey[];
    if (opts.entityScoped) {
      if (c.membership === null) continue;
      const allowed = c.membership.roleKeys;
      roles = allowed === null ? c.roles : c.roles.filter((r) => allowed.includes(r));
    } else {
      roles = c.roles;
    }
    if (roles.length === 0) continue;
    if (opts.roleOk !== undefined && !opts.roleOk(roles)) continue;
    const key = [...roles].sort().join(',');
    let granted = holds.get(key);
    if (granted === undefined) {
      const grants = await deps.grants.grantsFor(
        scope.tenantId,
        scope.organizationId,
        roles,
        'staff',
        q,
      );
      granted = grants.has(permission);
      holds.set(key, granted);
    }
    if (granted) out.push(c.userId);
  }
  return out.sort();
}

/**
 * True when the caller may use the small-team rule: they hold the Founder role and nobody else could do the step.
 * A non-Founder never qualifies, however small the team.
 */
export function isSoleEligible(
  principalRoles: readonly string[],
  others: readonly string[],
): boolean {
  return principalRoles.includes('founder') && others.length === 0;
}
