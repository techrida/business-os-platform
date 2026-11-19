// The authorization vocabulary: who is asking (`Principal`), what they touch (`ResourceRef`) and
// the answer (`Decision`). `can()` reads only these types, so authz stays pure and testable.
// Serves the NFR "authorization is deny-by-default, < 5 ms per decision" (P1 plan §1, k-authz).
import type { AccessLevel, AccessScope, OrgKind, Permission, RoleKey } from '@bos/contracts';
import type { ScopedTable } from '@bos/db';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { currentPrincipal } from '../tenancy/request-context';

/**
 * The caller, as authz sees them, for one request. Built by the tenancy interceptor after the
 * IdP org and the acting entity are resolved; `roles` and `grants` already belong to that entity.
 */
export interface Principal {
  /** `app.users.id` (uuid). Not the ZITADEL `sub`: rows reference our own user id. */
  userId: string;
  /** ZITADEL `sub`. */
  zitadelUserId: string;
  tenantId: string;
  /** The acting legal entity (ADR 0027 §4): named by `X-Entity-Id`, else the default. */
  organizationId: string;
  /** The kind of the caller's IdP org (ADR 0027): staff, or a customer or vendor portal. */
  orgKind: OrgKind;
  /** The customer or vendor party of a portal caller (`idp_orgs.party_id`); null for staff. */
  partyId: string | null;
  /** `app.idp_orgs.id` of the token's ZITADEL org. */
  idpOrgId: string;
  /** Effective roles in the acting entity: the token's roles narrowed by the membership. */
  roles: readonly RoleKey[];
  /** The department of the caller's membership in the acting entity; null for portal callers. */
  departmentId: string | null;
  /**
   * The level of that membership (D50). Absent reads as `staff`: portal callers have no membership, and a
   * principal built by hand (a test, a worker) without a level gets no level grant.
   */
  level?: AccessLevel;
  status: 'invited' | 'active' | 'inactive';
  /**
   * Every permission the caller's roles give, with the widest scope among those roles, already widened by the
   * level rows of the membership's level (RoleCache.grantsFor).
   */
  grants: ReadonlyMap<Permission, AccessScope>;
}

/**
 * The fields of a record that decide who may touch it. A caller fills in what the table has;
 * a missing field never matches, so leaving one out narrows access instead of widening it.
 */
export interface ResourceRef {
  tenantId: string;
  /** The owning org. For business documents that is the staff org, never the customer (ADR 0017). */
  organizationId: string;
  ownerUserId?: string | null;
  departmentId?: string | null;
  /** The customer party the record names (`customer_party_id`, ADR 0027 §5). */
  customerPartyId?: string | null;
  /** The vendor party the record names (`vendor_party_id`). */
  vendorPartyId?: string | null;
  /** Users who prepared the record and so must not approve it (separation of duties). */
  sodUserIds?: readonly string[];
  /**
   * Who entered the record (`leads.created_by_user_id`). Read reach only: `own` on a read permission that lists
   * creators in record-reach.ts also covers it. Fill it with `loadReaders`, never by hand, so the record check
   * and the list query (`scopeWhereFor`) read the same columns.
   */
  creatorUserId?: string | null;
  /**
   * Users holding a non-cancelled activity assignment on the record. Read reach only: they reach it with `own`
   * (and wider) on the table's read permission, and with `assigned`. Filled by `loadReaders`.
   */
  assigneeUserIds?: readonly string[];
}

export type DenyReason =
  | 'no_permission'
  | 'out_of_scope'
  | 'separation_of_duties'
  | 'inactive_user'
  /** ADR 0027 §4: the acting entity is unknown or the caller may not act for it (answered alike). */
  | 'entity_not_permitted';

export type Decision =
  { allowed: true; scope: AccessScope } | { allowed: false; reason: DenyReason };

/**
 * A Drizzle table that `AuthzService.scopeWhere()` can filter. The two tenancy columns are
 * required; the others are optional because only some tables have an owner, a department or a
 * counterparty. A scope whose column the table lacks matches no rows. Tables whose owner column has
 * another name, or that grant read reach to creators and assignees, are described in record-reach.ts.
 */
export type ScopableTable = ScopedTable & {
  ownerUserId?: AnyPgColumn;
  departmentId?: AnyPgColumn;
  customerPartyId?: AnyPgColumn;
  vendorPartyId?: AnyPgColumn;
};

/**
 * The current request's principal. Throws outside a request and on routes where none was bound
 * (`@Public()` routes, or before the interceptor ran), like `ctx()`: guessing a caller is worse
 * than failing loudly.
 */
export function principal(): Principal {
  const p = currentPrincipal();
  if (p === undefined || p === null) {
    throw new Error(
      'principal() called outside a request or before the principal was bound (public route?)',
    );
  }
  return p;
}
