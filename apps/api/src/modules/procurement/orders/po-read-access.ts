// Who may read purchase orders, and do what from one (F1-Q52, Kuu 2026-11-20). Procurement issues and changes orders
// (procurement.po.issue, the whole entity, as before). Read-only, the order is also open to whoever enters or reads
// vendor bills (the accountant, finance) and to whoever receives goods (the warehouse), on the orders their grant
// reaches through the order's purchase request (requester as owner, its department as department; record-reach.ts).
// No new permission: the live grants of those roles decide, so an admin who removes a bill or receipt grant also
// closes the orders. The list filter and the record check share these grants, so they cannot drift. An approver of an
// approval about the order also opens its detail, read-only and nothing else (approvesPo, R4f Q1 b).
import type { Permission, PoStatus } from '@bos/contracts';
import { approvalActions, approvalRequests, purchaseOrders, purchaseRequests } from '@bos/db';
import { ForbiddenException } from '@nestjs/common';
import { and, eq, inArray, or, sql, type SQL } from 'drizzle-orm';

import { can, type Principal } from '../../../platform/authz/can';
import type { Db } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { EMERGENCY_REVIEW_DOCUMENT_TYPE } from '../receipts/emergency-review';
import {
  purchaseRequestRef,
  purchaseRequestScopeWhere,
} from '../requests/purchase-requests.service';
import { PO_AMENDMENT_DOCUMENT_TYPE } from './purchase-order.rules';

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

/**
 * Holds some grant that opens purchase orders: the list and the versions are a 403 before any read otherwise; the
 * detail then asks approvesPo, and is a 404 for active staff it does not open.
 */
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

/** The step decisions an approver writes (approvals act()); submit, cancel, block and reroute are not. */
const STEP_DECISIONS = ['approve', 'return', 'reject'] as const;

/**
 * May `p` open order `poId` as an approver of an approval about it (R4f Q1 b)? Read-only, the detail only. Two kinds
 * point at an order: an emergency review (document id = the order) and an amendment (the order is in its snapshot).
 * True when `p` decided a step of one, themselves or as the person a delegate acted for, whatever the request's status
 * since (an approver may look back at what they decided), or when one waits in `p`'s inbox now. A step not yet
 * active grants nothing. `pendingInbox` is ApprovalsService.inbox(), whose rules pick who may decide now; it is only
 * asked when a pending request is linked. No transaction: call it outside withTx.
 */
export async function approvesPo(
  q: Db,
  scope: TxScope,
  p: Principal,
  poId: string,
  pendingInbox: () => Promise<readonly { requestId: string }[]>,
): Promise<boolean> {
  if (
    !activeStaff(p) ||
    p.tenantId !== scope.tenantId ||
    p.organizationId !== scope.organizationId
  ) {
    return false;
  }
  const linked = await q
    .select({ id: approvalRequests.id, status: approvalRequests.status })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, scope.tenantId),
        eq(approvalRequests.organizationId, scope.organizationId),
        or(
          and(
            eq(approvalRequests.documentType, EMERGENCY_REVIEW_DOCUMENT_TYPE),
            eq(approvalRequests.documentId, poId),
          ),
          and(
            eq(approvalRequests.documentType, PO_AMENDMENT_DOCUMENT_TYPE),
            sql`lower(${approvalRequests.snapshot} -> 'amendment' ->> 'purchaseOrderId') = ${poId.toLowerCase()}`,
          ),
        ),
      ),
    );
  return approvesAnyOf(q, scope, p, linked, pendingInbox);
}

/**
 * May `p` open the order of the approval request(s) about it found by `documentType` and `documentId`, as their
 * approver? approvesPo narrowed to those requests, so an approval context links the order only where the detail
 * route opens it. No transaction: call it outside withTx.
 */
export async function approvesRequestOf(
  q: Db,
  scope: TxScope,
  p: Principal,
  request: { documentType: string; documentId: string },
  pendingInbox: () => Promise<readonly { requestId: string }[]>,
): Promise<boolean> {
  if (
    !activeStaff(p) ||
    p.tenantId !== scope.tenantId ||
    p.organizationId !== scope.organizationId
  ) {
    return false;
  }
  const own = await q
    .select({ id: approvalRequests.id, status: approvalRequests.status })
    .from(approvalRequests)
    .where(
      and(
        eq(approvalRequests.tenantId, scope.tenantId),
        eq(approvalRequests.organizationId, scope.organizationId),
        eq(approvalRequests.documentType, request.documentType),
        eq(approvalRequests.documentId, request.documentId),
      ),
    );
  return approvesAnyOf(q, scope, p, own, pendingInbox);
}

/**
 * True when `p` decided a step of one of `requests` (themselves or as the person a delegate acted for), or a pending
 * one waits in their inbox now.
 */
async function approvesAnyOf(
  q: Db,
  scope: TxScope,
  p: Principal,
  requests: readonly { id: string; status: string }[],
  pendingInbox: () => Promise<readonly { requestId: string }[]>,
): Promise<boolean> {
  if (requests.length === 0) return false;
  const [decided] = await q
    .select({ id: approvalActions.id })
    .from(approvalActions)
    .where(
      and(
        eq(approvalActions.tenantId, scope.tenantId),
        eq(approvalActions.organizationId, scope.organizationId),
        inArray(
          approvalActions.requestId,
          requests.map((r) => r.id),
        ),
        inArray(approvalActions.action, [...STEP_DECISIONS]),
        or(
          eq(approvalActions.actorUserId, p.userId),
          eq(approvalActions.onBehalfOfUserId, p.userId),
        ),
      ),
    )
    .limit(1);
  if (decided !== undefined) return true;
  const pending = new Set(requests.filter((r) => r.status === 'pending').map((r) => r.id));
  if (pending.size === 0) return false;
  let inbox: readonly { requestId: string }[];
  try {
    inbox = await pendingInbox();
  } catch (error) {
    // The inbox is a 403 for a caller with no approval assignment at all: nothing waits for them.
    if (error instanceof ForbiddenException) return false;
    throw error;
  }
  return inbox.some((item) => pending.has(item.requestId));
}

/**
 * May `p` receive, confirm, discard or reverse a receipt of `kind` on the order raised from `request`? The rule the
 * receipts unit enforces (assertMayReceive): goods need procurement.receipt.confirm on the order's request; a service
 * may also be handled by the request's requester. Anyone else only reads.
 */
export function mayReceiveKind(
  p: Principal,
  kind: 'goods' | 'service',
  request: PoRequestFacts,
): boolean {
  if (!activeStaff(p)) return false;
  if (can(p, 'procurement.receipt.confirm', purchaseRequestRef(request)).allowed) return true;
  return (
    kind === 'service' &&
    p.organizationId === request.organizationId &&
    p.userId === request.requesterUserId
  );
}

/** mayReceiveKind for some line of the order, on an order that still takes receipts: Receive goods on the order. */
export function mayReceivePo(
  p: Principal,
  status: PoStatus,
  request: PoRequestFacts,
  hasServiceLines: boolean,
): boolean {
  if (!RECEIVABLE.includes(status)) return false;
  return (
    mayReceiveKind(p, 'goods', request) ||
    (hasServiceLines && mayReceiveKind(p, 'service', request))
  );
}
