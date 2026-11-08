// The authorization vocabulary: who is asking (`Principal`), what they touch (`ResourceRef`) and
// the answer (`Decision`). `can()` reads only these types, so authz stays pure and testable.
// Serves the NFR "authorization is deny-by-default, < 5 ms per decision" (P1 plan §1, k-authz).
import type { OrgKind, Permission, RoleKey, Scope } from '@bos/contracts';
import type { ScopedTable } from '@bos/db';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';

import { currentPrincipal } from '../tenancy/request-context';

/**
 * The caller, as authz sees them, for one request. Built by the tenancy interceptor after the
 * org is resolved; `roles` and `grants` already belong to that org only.
 */
export interface Principal {
  /** `app.users.id` (uuid). Not the ZITADEL `sub`: rows reference our own user id. */
  userId: string;
  /** ZITADEL `sub`. */
  zitadelUserId: string;
  tenantId: string;
  organizationId: string;
  orgKind: OrgKind;
  roles: readonly RoleKey[];
  departmentId: string | null;
  status: 'invited' | 'active' | 'inactive';
  /** Every permission the caller's roles give, with the widest scope among those roles. */
  grants: ReadonlyMap<Permission, Scope>;
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
  customerOrganizationId?: string | null;
  vendorOrganizationId?: string | null;
  /** Users who prepared the record and so must not approve it (separation of duties). */
  sodUserIds?: readonly string[];
}

export type DenyReason =
  'no_permission' | 'out_of_scope' | 'separation_of_duties' | 'inactive_user';

export type Decision = { allowed: true; scope: Scope } | { allowed: false; reason: DenyReason };

/**
 * A Drizzle table that `AuthzService.scopeWhere()` can filter. The two tenancy columns are
 * required; the others are optional because only some tables have an owner, a department or a
 * counterparty. A scope whose column the table lacks matches no rows.
 */
export type ScopableTable = ScopedTable & {
  ownerUserId?: AnyPgColumn;
  departmentId?: AnyPgColumn;
  customerOrganizationId?: AnyPgColumn;
  vendorOrganizationId?: AnyPgColumn;
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
