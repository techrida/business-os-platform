// The review of an emergency purchase after receipt (F1-Q41, Kuu 2026-11-20). An emergency purchase request is
// approved by Management at the request (AD12, so buying can start with fewer quotations), then runs the normal
// commitment route; once its order has received everything, Management reviews what was bought. The review is a
// request on the existing approval engine: one Management step, the workflow's SLA reminds after 72 hours (the due
// date) and escalates to the Founder after 7 days. Deciding it changes no record; it is audited.
// - The review is asked for once per order, by whatever first brings the order to the end of its receiving
//   (emergencyReviewDue): a receipt confirmation that makes it fully_received, a short-close, or an amendment
//   (applied at once or after its approval) that leaves it fully_received. A reversal and a second confirmation do
//   not ask again.
// - The action never fails because of the review: an entity with no published review workflow gets an audit row and
//   a log line instead of a request (checked with a read before the submit, so nothing is aborted).
import type { ApprovalContext, PoStatus } from '@bos/contracts';
import {
  approvalRequests,
  purchaseOrders,
  purchaseRequests,
  scoped,
  vendors,
  workflowDefinitions,
  workflowVersions,
} from '@bos/db';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { fact } from '../../approvals/context';
import type { ApprovalSubject, ApprovalsService } from '../../approvals/requests.service';
import {
  approvesRequestOf,
  mayReadPo,
  requestFactsColumns,
  requestOf,
} from '../orders/po-read-access';
import { idAt, procurementReferenceNames } from '../reference-names';

/** approval_requests.document_type of the review; the document id is the purchase order's id. */
export const EMERGENCY_REVIEW_DOCUMENT_TYPE = 'emergency_review';

/**
 * v1 of the review route, published per entity by migration 0130 (the SQL holds a word-for-word copy, pinned by
 * emergency-review.test.ts). Management reviews; the reminder after 72 hours is the review's due date.
 */
export const EMERGENCY_REVIEW_WORKFLOW_SPEC: unknown = {
  documentType: EMERGENCY_REVIEW_DOCUMENT_TYPE,
  steps: [
    {
      id: 'management',
      kind: 'role',
      role: 'management',
      reason: 'Management reviews an emergency purchase after it was received',
    },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 72, escalateAfterHours: 168, escalateTo: { role: 'founder' } },
};

const log = new Logger('EmergencyReview');

/** The statuses an order ends its receiving in: everything was received, or the rest was short-closed. */
const RECEIVING_ENDED: readonly PoStatus[] = ['fully_received', 'short_closed'];

/**
 * Whether a move of the order from `from` to `to` should ask for the review: the order newly ends its receiving.
 * An approved amendment moves from amendment_pending, so it always asks when it leaves the order fully_received;
 * requestEmergencyReview's own check keeps that to one request per order.
 */
export const emergencyReviewDue = (from: PoStatus, to: PoStatus): boolean =>
  RECEIVING_ENDED.includes(to) && !RECEIVING_ENDED.includes(from);

/**
 * Asks Management to review the emergency purchase behind `po`, inside the transaction of the action that ended its
 * receiving. Does nothing for an order of an ordinary request, or when this order was already sent for review.
 * `actorUserId` is who did that action (took the goods in, short-closed or amended the order); they do not review.
 */
export async function requestEmergencyReview(
  tx: DbTransaction,
  scope: TxScope,
  deps: { approvals: ApprovalsService; audit: AuditService },
  po: { id: string; number: string; vendorId: string; purchaseRequestId: string },
  actorUserId: string,
): Promise<'requested' | 'not_emergency' | 'already_requested' | 'not_configured'> {
  const [pr] = await tx
    .select({
      number: purchaseRequests.number,
      isEmergency: purchaseRequests.isEmergency,
      emergencyReason: purchaseRequests.emergencyReason,
      requesterUserId: purchaseRequests.requesterUserId,
    })
    .from(purchaseRequests)
    .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)));
  if (pr === undefined || !pr.isEmergency) return 'not_emergency';

  const [existing] = await tx
    .select({ id: approvalRequests.id })
    .from(approvalRequests)
    .where(
      scoped(scope).where(
        approvalRequests,
        and(
          eq(approvalRequests.documentType, EMERGENCY_REVIEW_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, po.id),
        ),
      ),
    )
    .limit(1);
  if (existing !== undefined) return 'already_requested';

  const [published] = await tx
    .select({ id: workflowVersions.id })
    .from(workflowDefinitions)
    .innerJoin(workflowVersions, eq(workflowVersions.id, workflowDefinitions.currentVersionId))
    .where(
      and(
        eq(workflowDefinitions.tenantId, scope.tenantId),
        eq(workflowDefinitions.organizationId, scope.organizationId),
        eq(workflowDefinitions.documentType, EMERGENCY_REVIEW_DOCUMENT_TYPE),
        eq(workflowVersions.status, 'published'),
      ),
    )
    .limit(1);
  if (published === undefined) {
    log.warn(`no published ${EMERGENCY_REVIEW_DOCUMENT_TYPE} workflow; order ${po.id} not sent`);
    await deps.audit.record(tx, {
      action: 'procurement.emergency_review.not_configured',
      entityType: 'purchase_orders',
      entityId: po.id,
      after: { purchaseRequestId: po.purchaseRequestId },
    });
    return 'not_configured';
  }

  const [vendor] = await tx
    .select({ legalName: vendors.legalName })
    .from(vendors)
    .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, po.vendorId)));
  const request = await deps.approvals.submit(tx, {
    documentType: EMERGENCY_REVIEW_DOCUMENT_TYPE,
    documentId: po.id,
    documentNumber: po.number,
    title: `Review of emergency purchase ${po.number}`,
    snapshot: {
      purchaseOrderId: po.id,
      purchaseOrderNumber: po.number,
      purchaseRequestId: po.purchaseRequestId,
      purchaseRequestNumber: pr.number,
      vendorPartyId: po.vendorId,
      vendorName: vendor?.legalName ?? null,
      emergencyReason: pr.emergencyReason,
    },
    facts: {},
    requesterUserId: pr.requesterUserId,
    submittedByUserId: actorUserId,
    // Whoever asked for the purchase, or took it in or closed it, does not review it.
    sodUserIds: [pr.requesterUserId, actorUserId],
  });
  await deps.audit.record(tx, {
    action: 'procurement.emergency_review.requested',
    entityType: 'purchase_orders',
    entityId: po.id,
    after: { approvalRequestId: request.requestId, status: request.status },
  });
  return 'requested';
}

export class EmergencyReviewSubject implements ApprovalSubject {
  readonly documentType = EMERGENCY_REVIEW_DOCUMENT_TYPE;

  constructor(
    private readonly audit: AuditService,
    /** The reader's inbox, for whether the review waits for them now (the order link). */
    private readonly approvals: Pick<ApprovalsService, 'inbox'>,
  ) {}

  /** The order by number and its vendor by legal name. */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, {
      purchaseOrderIds: [idAt(snapshot, 'purchaseOrderId')],
      vendorIds: [idAt(snapshot, 'vendorPartyId')],
    });
  }

  /**
   * The order as it stands now, with why it was an emergency. Linked only for a viewer the order's detail route lets
   * in (po-read-access.ts): a reader of the order, or an approver of this review (it waits for them, or they decided
   * it), who opens the detail read-only. Whoever only submitted it gets no link.
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string; snapshot: unknown },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const [po] = await q
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        status: purchaseOrders.status,
        currency: purchaseOrders.currency,
        approvedTotal: purchaseOrders.approvedTotal,
        vendorName: vendors.legalName,
        emergencyReason: purchaseRequests.emergencyReason,
        request: requestFactsColumns,
      })
      .from(purchaseOrders)
      .leftJoin(
        vendors,
        and(eq(vendors.tenantId, purchaseOrders.tenantId), eq(vendors.id, purchaseOrders.vendorId)),
      )
      .innerJoin(purchaseRequests, requestOf(purchaseOrders))
      .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, request.documentId)));
    if (po === undefined) return null;
    const linked =
      mayReadPo(viewer, po.request) ||
      (await approvesRequestOf(
        q,
        scope,
        viewer,
        { documentType: EMERGENCY_REVIEW_DOCUMENT_TYPE, documentId: request.documentId },
        () => this.approvals.inbox(),
      ));
    return {
      title: `Purchase order ${po.number}`,
      fields: [
        ...fact.text('vendor', 'Vendor', po.vendorName),
        ...fact.text('emergencyReason', 'Why it was an emergency', po.emergencyReason),
        ...fact.money('approvedTotal', 'Approved total', po.approvedTotal, po.currency),
        ...fact.status(po.status),
      ],
      documents: [],
      href: linked ? `/procurement/orders/${po.id}` : null,
    };
  }

  /** A review changes no record: the decision is the engine's, and it is audited here on the order. */
  async onDecided(
    tx: DbTransaction,
    purchaseOrderId: string,
    outcome: 'approved' | 'returned' | 'rejected',
  ): Promise<void> {
    await this.audit.record(tx, {
      action: `procurement.emergency_review.${outcome}`,
      entityType: 'purchase_orders',
      entityId: purchaseOrderId,
      after: { outcome },
    });
  }
}
