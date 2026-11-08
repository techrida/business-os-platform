// The one authorization decision: may this principal do this action, optionally on this record?
// Pure and synchronous with no I/O, so it is table-testable and costs microseconds. Serves the NFRs
// "authorization is deny-by-default" and "< 5 ms per decision" (P1 plan §1, k-authz; §7 U1).
import { type Permission, type Scope, SCOPES, SOD_PERMISSIONS } from '@bos/contracts';

import type { Decision, DenyReason, Principal, ResourceRef } from './principal';

// The types live in principal.ts; re-exported so callers can import the decision and its inputs
// from one place (U4's documents ports import `ResourceRef` from here).
export type { Decision, DenyReason, Principal, ResourceRef } from './principal';

// Frozen, shared answers: `can()` allocates nothing per call, so a hot list check makes no garbage
// and its p99 stays flat under GC.
const deny = (reason: DenyReason): Decision => Object.freeze({ allowed: false, reason });
const DENY_INACTIVE = deny('inactive_user');
const DENY_NO_PERMISSION = deny('no_permission');
const DENY_OUT_OF_SCOPE = deny('out_of_scope');
const DENY_SOD = deny('separation_of_duties');

// A Map, not an object literal: `ALLOW.get('toString')` is undefined, where `obj['toString']`
// would return an inherited function and read as an allow.
const ALLOW: ReadonlyMap<Scope, Decision> = new Map(
  SCOPES.map((scope) => [scope, Object.freeze({ allowed: true, scope }) as Decision]),
);

const SOD: ReadonlySet<Permission> = new Set(SOD_PERMISSIONS);

/** Equal and a real id. `null`, `undefined` and `''` never match anything, not even each other. */
const sameId = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && a.length > 0 && a === b;

/** The record's counterparty column that names the principal's org kind, if it has one. */
function counterpartyOf(p: Principal, r: ResourceRef): string | null | undefined {
  if (p.orgKind === 'customer') return r.customerOrganizationId;
  if (p.orgKind === 'vendor') return r.vendorOrganizationId;
  // Staff orgs are never a counterparty: staff reach records through ownership, not this column.
  return undefined;
}

/** Does `scope` reach `r` for `p`? The tenant was already checked by the caller. */
function inScope(p: Principal, scope: Scope, r: ResourceRef): boolean {
  switch (scope) {
    // `own` and `department` also need the principal's own org, so a record check agrees with the
    // list query: `scopeWhere()` builds these on `scoped()`, which filters tenant and org.
    case 'own':
      return sameId(r.organizationId, p.organizationId) && sameId(r.ownerUserId, p.userId);
    case 'department':
      // A user with no department has no department scope; two nulls are not a match.
      return (
        p.departmentId !== null &&
        sameId(r.organizationId, p.organizationId) &&
        sameId(r.departmentId, p.departmentId)
      );
    case 'customer_org':
      // The portal rule (ADR 0017): match the counterparty column, never `organizationId`. A
      // customer matches only the customer column and a vendor only the vendor column.
      return sameId(counterpartyOf(p, r), p.organizationId);
    case 'all':
      // `all` means "everything my org holds", not "everything in the tenant".
      // - Staff: rows owned by the staff org (`organizationId`). Business documents that name a
      //   customer or vendor are still owned by the staff org (ADR 0017), so they are covered. A row
      //   owned by a customer org (its own users, say) is out of scope for staff.
      // - Customer or vendor: rows owned by its own org, plus rows that name it in its own
      //   counterparty column. It never reaches a staff-owned row through `organizationId`, and
      //   never through the other kind's counterparty column.
      if (sameId(r.organizationId, p.organizationId)) return true;
      return p.orgKind !== 'staff' && sameId(counterpartyOf(p, r), p.organizationId);
    default:
      // A scope string this code does not know (a bad `role_permissions` row) grants nothing.
      return false;
  }
}

/**
 * Decides whether `p` may perform `action`, and on which record when `r` is given.
 *
 * The checks run in this order, and the first failure is the answer:
 * 1. Status. Only `active` passes. `invited` is treated as inactive in P1: an invited user has not
 *    finished sign-up (no password or MFA yet), so a token for them should not act. Any other
 *    status string, including one this code does not know, also denies.
 * 2. Grant. No grant for `action` is `no_permission`.
 * 3. No `r`: a route-level check, and the grant alone decides.
 * 4. Tenant. A different tenant is always `out_of_scope`, whatever the scope.
 * 5. Scope (see `inScope`).
 * 6. Separation of duties. For `SOD_PERMISSIONS`, a user listed in `r.sodUserIds` is refused even
 *    when in scope. Scope runs first so an out-of-scope caller learns nothing about who prepared it.
 *    A record check with no `sodUserIds` at all is refused too (review R14): a caller that forgot to
 *    load who prepared the record must not skip the check. An empty list means "nobody prepared
 *    it" and passes.
 */
export function can(p: Principal, action: Permission, r?: ResourceRef): Decision {
  if (p.status !== 'active') return DENY_INACTIVE;

  const scope = p.grants.get(action);
  if (scope === undefined) return DENY_NO_PERMISSION;

  const allow = ALLOW.get(scope);
  // An unknown scope value from the database is not a grant.
  if (allow === undefined) return DENY_NO_PERMISSION;

  if (r === undefined) return allow;

  if (!sameId(r.tenantId, p.tenantId)) return DENY_OUT_OF_SCOPE;
  if (!inScope(p, scope, r)) return DENY_OUT_OF_SCOPE;

  if (SOD.has(action) && (r.sodUserIds === undefined || r.sodUserIds.includes(p.userId))) {
    return DENY_SOD;
  }
  return allow;
}
