// Who may read purchase orders, and do what from one (F1-Q52, Kuu 2026-11-20). Procurement issues and changes orders
// (procurement.po.issue, the whole entity, as before). Read-only, the order is also open to whoever enters or reads
// vendor bills (the accountant, finance) and to whoever receives goods (the warehouse), on the orders their grant
// reaches through the order's purchase request (requester as owner, its department as department; record-reach.ts).
// No new permission: the live grants of those roles decide, so an admin who removes a bill or receipt grant also
// closes the orders. The list filter and the record check share these grants, so they cannot drift.
import type { Permission, PoStatus } from '@bos/contracts';
import { purchaseOrders, purchaseRequests } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { and, eq, or, type SQL } from 'drizzle-orm';

import { can, type Principal } from '../../../platform/authz/can';
import {
  purchaseRequestRef,
  purchaseRequestScopeWhere,
} from '../requests/purchase-requests.service';

/** Issue, amend, short-close and cancel; also reads every order of the entity. */
export const PO_ISSUE_ACTION: Permission = 'procurement.po.issue';

/** The grants that open an order read-only, each under its own scope on the order's purchase request. */
export const PO_READ_ONLY_ACTIONS: readonly Permission[] = [
  'payables.bill.enter',
  'payables.bill.read',
  'procurement.receipt.confirm',
];

/** The order's purchase request, as purchaseRequestRef reads it. */
export type PoRequestFacts = Parameters<typeof purchaseRequestRef>[0];

/** Joins an order to the purchase request it was raised from (every order has one). */
export const requestOf = (po: typeof purchaseOrders) =>
  and(
    eq(purchaseRequests.tenantId, po.tenantId),
    eq(purchaseRequests.organizationId, po.organizationId),
    eq(purchaseRequests.id, po.purchaseRequestId),
  );

/** The request columns purchaseRequestRef reads, to select beside an order joined with requestOf. */
export const requestFactsColumns = {
  tenantId: purchaseRequests.tenantId,
  organizationId: purchaseRequests.organizationId,
  requesterUserId: purchaseRequests.requesterUserId,
  departmentId: purchaseRequests.departmentId,
};

/** The statuses that still take a receipt (the receipts unit refuses the rest). */
const RECEIVABLE: readonly PoStatus[] = ['issued', 'partially_received'];

const activeStaff = (p: Principal): boolean => p.status === 'active' && p.orgKind === 'staff';

/** Holds some grant that opens purchase orders: the list and the detail are a 403 before any read otherwise. */
export function holdsPoRead(p: Principal): boolean {
  return (
    activeStaff(p) &&
    (p.grants.has(PO_ISSUE_ACTION) || PO_READ_ONLY_ACTIONS.some((a) => p.grants.has(a)))
  );
}

/** 403 for a portal caller, an inactive user and a staff member with none of the grants. */
export function assertHoldsPoRead(p: Principal): void {
  if (holdsPoRead(p)) return;
  throw new ForbiddenException({
    code: 'forbidden',
    message: 'Forbidden',
    reason: p.status === 'active' ? 'no_permission' : 'inactive_user',
  });
}

/** May `p` open the order raised from `request`? A grant that does not reach it is a 404 at the caller. */
export function mayReadPo(p: Principal, request: PoRequestFacts): boolean {
  if (!activeStaff(p)) return false;
  if (p.grants.has(PO_ISSUE_ACTION)) return true;
  const ref = purchaseRequestRef(request);
  return PO_READ_ONLY_ACTIONS.some((a) => can(p, a, ref).allowed);
}

/**
 * The SQL twin of mayReadPo on `purchase_requests` (join it to the orders): undefined for an issuer, who reads the
 * whole entity, else the rows any read-only grant reaches. An inactive or portal caller matches nothing.
 */
export function poReadWhere(p: Principal): SQL | undefined {
  if (activeStaff(p) && p.grants.has(PO_ISSUE_ACTION)) return undefined;
  return or(...PO_READ_ONLY_ACTIONS.map((a) => purchaseRequestScopeWhere(p, a)));
}

/**
 * May `p` take in what arrives on this order? The rule the receipts unit applies (assertMayReceive): goods need
 * procurement.receipt.confirm on the order's request; a service may also be confirmed by the request's requester.
 * Only on an order that still takes receipts.
 */
export function mayReceivePo(
  p: Principal,
  status: PoStatus,
  request: PoRequestFacts,
  hasServiceLines: boolean,
): boolean {
  if (!activeStaff(p) || !RECEIVABLE.includes(status)) return false;
  if (can(p, 'procurement.receipt.confirm', purchaseRequestRef(request)).allowed) return true;
  return (
    hasServiceLines &&
    p.organizationId === request.organizationId &&
    p.userId === request.requesterUserId
  );
}
