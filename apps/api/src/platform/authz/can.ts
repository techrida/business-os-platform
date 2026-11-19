// The one authorization decision: may this principal do this action, optionally on this record?
// Pure and synchronous with no I/O, so it is table-testable and costs microseconds. Serves the NFRs
// "authorization is deny-by-default" and "< 5 ms per decision" (P1 plan §1, k-authz; §7 U1).
import { ACCESS_SCOPES, type AccessScope, type Permission, SOD_PERMISSIONS } from '@bos/contracts';

import type { Decision, DenyReason, Principal, ResourceRef } from './principal';
import { type ReadReach, readReachOf } from './record-reach';

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
const ALLOW: ReadonlyMap<AccessScope, Decision> = new Map(
  ACCESS_SCOPES.map((scope) => [scope, Object.freeze({ allowed: true, scope }) as Decision]),
);

const SOD: ReadonlySet<Permission> = new Set(SOD_PERMISSIONS);

/** Equal and a real id. `null`, `undefined` and `''` never match anything, not even each other. */
const sameId = (a: string | null | undefined, b: string | null | undefined): boolean =>
  typeof a === 'string' && a.length > 0 && a === b;

/**
 * The record's counterparty column for the principal's org kind, if it has one. It holds a party id
 * (`customer_party_id` / `vendor_party_id`, ADR 0027 §5) and is compared with `p.partyId` only.
 */
function counterpartyOf(p: Principal, r: ResourceRef): string | null | undefined {
  if (p.orgKind === 'customer') return r.customerPartyId;
  if (p.orgKind === 'vendor') return r.vendorPartyId;
  // Staff are never a counterparty: staff reach records through the entity, not this column.
  return undefined;
}

/**
 * The portal rule (ADR 0017, revised by ADR 0027 §5): a row of the acting entity whose counterparty
 * column names the caller's party. Never `organizationId` alone: for a portal caller that is the
 * acting entity, which owns every business document, so it would reach the whole entity.
 */
const namesMyParty = (p: Principal, r: ResourceRef): boolean =>
  sameId(r.organizationId, p.organizationId) && sameId(counterpartyOf(p, r), p.partyId);

/**
 * `r` is one of `p`'s own records. Scopes are cumulative (spec A2, review R1): `own` is in `department` and
 * `all`, so this is the base of each. On a read permission with read reach (record-reach.ts) it also covers the
 * record's creator and assignees; a write never does (D55-3), so `reach` is undefined for every write.
 */
function isMine(p: Principal, r: ResourceRef, reach: ReadReach | undefined): boolean {
  if (sameId(r.ownerUserId, p.userId)) return true;
  if (reach === undefined) return false;
  if (reach.creator && sameId(r.creatorUserId, p.userId)) return true;
  return reach.assignee && isAssignee(p, r);
}

const isAssignee = (p: Principal, r: ResourceRef): boolean =>
  r.assigneeUserIds !== undefined && p.userId.length > 0 && r.assigneeUserIds.includes(p.userId);

/** Does `scope` reach `r` for `p`? The tenant was already checked by the caller. */
function inScope(
  p: Principal,
  scope: AccessScope,
  r: ResourceRef,
  reach: ReadReach | undefined,
): boolean {
  switch (scope) {
    // `assigned`, `own` and `department` also need the acting entity, so a record check agrees with
    // the list query: `scopeWhere()` builds these on `scoped()`, which filters tenant and entity.
    case 'assigned':
      // Only work given to them, read only. `can()` already refused this scope on any permission without
      // assignee reach, so `reach` is defined here.
      return (
        sameId(r.organizationId, p.organizationId) && reach?.assignee === true && isAssignee(p, r)
      );
    case 'own':
      return sameId(r.organizationId, p.organizationId) && isMine(p, r, reach);
    case 'department':
      // Own records count wherever they sit. A user with no department reaches only those, and two nulls are
      // not a match; a record (or table) with no department is reached as `own` (review R2).
      return (
        sameId(r.organizationId, p.organizationId) &&
        (isMine(p, r, reach) ||
          (p.departmentId !== null && sameId(r.departmentId, p.departmentId)))
      );
    case 'customer_org':
      // A customer matches only the customer column and a vendor only the vendor column; staff
      // match nothing. A party id that happens to equal an entity id grants nothing.
      return namesMyParty(p, r);
    case 'all':
      // `all` means "everything the acting entity holds that I may see", not "the whole tenant".
      // - Staff: every row of the acting entity, including the ones that name a customer or vendor.
      // - Customer or vendor: the same rows as `customer_org`. Its `organizationId` is the acting
      //   entity, so "rows my org owns" would be every staff document; a party owns no entity rows.
      if (p.orgKind === 'staff') return sameId(r.organizationId, p.organizationId);
      return namesMyParty(p, r);
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
 * 2. Grant. No grant for `action` is `no_permission`. So is `assigned` on a permission without assignee
 *    reach (any write, and every read that no assignment can hand over): it grants nothing there.
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

  // Read reach exists only on the read permissions record-reach.ts names, so writes ignore creators and
  // assignees, and `assigned` means nothing on any other permission.
  const reach = readReachOf(action);
  if (scope === 'assigned' && reach?.assignee !== true) return DENY_NO_PERMISSION;

  if (r === undefined) return allow;

  if (!sameId(r.tenantId, p.tenantId)) return DENY_OUT_OF_SCOPE;
  if (!inScope(p, scope, r, reach)) return DENY_OUT_OF_SCOPE;

  if (SOD.has(action) && (r.sodUserIds === undefined || r.sodUserIds.includes(p.userId))) {
    return DENY_SOD;
  }
  return allow;
}
