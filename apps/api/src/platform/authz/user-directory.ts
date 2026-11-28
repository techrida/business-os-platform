// The port authz uses to look up users without depending on the users module (P1 plan §6.2).
// U6's `UsersModule` is global and provides it with `{ provide: UserDirectory, useExisting: UsersService }`.
// An abstract class, not an interface, so Nest can use it as the injection token.
import type { AccessLevel, RoleKey } from '@bos/contracts';

import type { Db, DbTransaction } from '../db/db.module';
import type { Actor, TxScope } from '../db/tx';

/**
 * One `app.user_entities` row: a legal entity the user may act for (ADR 0027 §3). Portal users have
 * none; they act in the tenant's entities through their party.
 */
export interface EntityMembership {
  organizationId: string;
  isDefault: boolean;
  /** Narrows the token's roles in this entity; null means every token role counts. */
  roleKeys: string[] | null;
  departmentId: string | null;
  /** The member's level in this entity (D50, migration 0079). Absent reads as `staff`. */
  level?: AccessLevel;
}

/**
 * A user row as the tenancy interceptor needs it. `tenantId` and `idpOrgId` are the row's own, so
 * the interceptor can refuse a row that does not match the token's IdP org (review R26).
 */
export interface ResolvedUser {
  userId: string;
  tenantId: string;
  idpOrgId: string;
  status: 'active' | 'inactive' | 'invited';
  memberships: EntityMembership[];
}

export abstract class UserDirectory {
  /**
   * Maps a token identity to our user row. Creates the row (status `active`) and enqueues
   * `users.sync` when it is missing, so a first login works before the webhook arrives.
   *
   * The lookup is by ZITADEL id alone, so it returns the row's own `tenantId` and `idpOrgId`: the
   * tenancy interceptor refuses the request when they differ from the token's IdP org (review R26).
   * `idpOrgId` is the token's IdP org: a JIT-created user is placed in it (`users.idp_org_id` is NOT
   * NULL), and a staff user gets its bootstrap membership in the tenant's default entity (ADR 0027 §3).
   * The acting entity is chosen only after this call, from the memberships it returns.
   */
  abstract resolve(i: {
    zitadelUserId: string;
    tenantId: string;
    idpOrgId: string;
  }): Promise<ResolvedUser>;

  /** Best-effort staff activity tracking after route authorization. */
  recordActivity?(scope: TxScope, actor: Actor): void;

  /**
   * Active users holding `role` in this scope: the approver lookup for routing and notifications. A caller inside a
   * transaction passes it as `q`, so the read does not take a second pooled connection while the transaction holds
   * one (that can stall the pool under load). Without `q` the read uses the pool.
   */
  abstract userIdsWithRole(
    scope: TxScope,
    role: RoleKey,
    q?: Db | DbTransaction,
  ): Promise<string[]>;

  /**
   * `userIdsWithRole` for several roles in one statement: every role asked for is a key of the map. Optional, so the
   * many test doubles of this port need not implement it; the approvals directory loader falls back to one read per
   * role without it.
   */
  userIdsWithRoles?(
    scope: TxScope,
    roles: readonly RoleKey[],
    q?: Db | DbTransaction,
  ): Promise<Map<RoleKey, string[]>>;

  /** The address to email, or null when the user has none or is unknown. `q` as for userIdsWithRole. */
  abstract emailOf(userId: string, q?: Db | DbTransaction): Promise<string | null>;
}
