// Live grants for a write that must not trust the sign-in token (U20b-Q3). The tenancy interceptor
// builds the principal from the token's roles, so a person whose role was taken away keeps acting
// with it until the token expires. A route that changes who may do what re-reads the caller's
// CURRENT roles from the user mirror inside its own transaction, narrows them by the acting
// entity's membership the way the interceptor does (ADR 0027 §3), and asks the role cache for the
// grants of those roles at the membership's level.
//
// Only the roles come from the mirror; the role -> permission table is the role cache's (a change
// to it bumps `authz_versions`, which the cache checks every 5 s).
import type { AccessLevel, AccessScope, Permission, RoleKey } from '@bos/contracts';
import { ForbiddenException } from '@nestjs/common';

import type { DbTransaction } from '../db/db.module';
import type { Actor, TxScope } from '../db/tx';
import type { MembershipRow, UserRow } from '../users/users.store';
import type { DenyReason } from './principal';

/** The user-mirror reads the check needs; `SqlUsersStore` satisfies it. */
export interface LiveRoleSource {
  findById(q: DbTransaction, scope: TxScope, userId: string): Promise<UserRow | null>;
  rolesOf(q: DbTransaction, tenantId: string, userId: string): Promise<RoleKey[]>;
  membershipsOf(q: DbTransaction, tenantId: string, userId: string): Promise<MembershipRow[]>;
}

/** The role -> permission table; `RoleCache` satisfies it. */
export interface LiveGrantTable {
  grantsFor(
    tenantId: string,
    organizationId: string,
    roles: readonly RoleKey[],
    level?: AccessLevel,
  ): Promise<ReadonlyMap<Permission, AccessScope>>;
}

export interface LiveGrantDeps {
  users: LiveRoleSource;
  grants: LiveGrantTable;
}

export interface LiveGrants {
  /** Null when the user row is missing from this tenant. */
  status: UserRow['status'] | null;
  /** Mirror roles narrowed by the acting entity's membership; empty without a membership there. */
  roles: readonly RoleKey[];
  departmentId: string | null;
  level: AccessLevel;
  grants: ReadonlyMap<Permission, AccessScope>;
}

const NO_GRANTS: ReadonlyMap<Permission, AccessScope> = new Map();

/**
 * The caller's grants in `scope` as the database says now. A user with no membership in the acting
 * entity has no roles there, so no grants (the interceptor refuses such a caller outright).
 */
export async function liveGrantsOf(
  q: DbTransaction,
  deps: LiveGrantDeps,
  scope: TxScope,
  userId: string,
): Promise<LiveGrants> {
  // One after another: the three reads share the transaction's single connection.
  const user = await deps.users.findById(q, scope, userId);
  const mirrorRoles = await deps.users.rolesOf(q, scope.tenantId, userId);
  const memberships = await deps.users.membershipsOf(q, scope.tenantId, userId);
  const entity = scope.organizationId.toLowerCase();
  const membership = memberships.find((m) => m.organizationId.toLowerCase() === entity);
  if (user === null || membership === undefined) {
    return {
      status: user?.status ?? null,
      roles: [],
      departmentId: null,
      level: 'staff',
      grants: NO_GRANTS,
    };
  }

  // Effective roles = mirror roles ∩ the membership's role keys (null: every mirror role).
  const allowed = membership.roleKeys;
  const roles = allowed === null ? mirrorRoles : mirrorRoles.filter((r) => allowed.includes(r));
  const departmentId = membership.departmentId;
  const level: AccessLevel = membership.level ?? 'staff';
  // A level widens a grant to the department; with no department the grants are the staff ones.
  const grants =
    roles.length === 0
      ? NO_GRANTS
      : await deps.grants.grantsFor(
          scope.tenantId,
          scope.organizationId,
          roles,
          departmentId === null ? 'staff' : level,
        );
  return { status: user.status, roles, departmentId, level, grants };
}

const forbidden = (reason: DenyReason): ForbiddenException =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

/**
 * Throws 403 unless `actor` is an active user who holds `permission` in `scope` right now. Call it
 * inside the write's transaction, after any lock that serialises the write, so the answer holds
 * for the rest of the transaction. Non-user actors are refused: these routes are people-only.
 */
export async function assertLiveGrant(
  q: DbTransaction,
  deps: LiveGrantDeps,
  scope: TxScope,
  actor: Actor,
  permission: Permission,
): Promise<LiveGrants> {
  if (actor.kind !== 'user') throw forbidden('no_permission');
  const live = await liveGrantsOf(q, deps, scope, actor.id);
  if (live.status === null) throw forbidden('no_permission');
  if (live.status !== 'active') throw forbidden('inactive_user');
  if (!live.grants.has(permission)) throw forbidden('no_permission');
  return live;
}
