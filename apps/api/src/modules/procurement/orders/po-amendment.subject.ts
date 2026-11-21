// The po_amendment approval subject (P4 unit P3; AD7): what a decided amendment does to its PO, in the deciding
// transaction (ApprovalsService.act), so the decision and its effects commit or roll back together.
// The document id is the amendment's own id (a fresh uuid per amendment), so each request names exactly one
// proposal; the proposal itself is the `amendment` part of the request's snapshot.
// - approved: version N+1 is written from the proposal and approved_total, approved_total_npr and approved_band move
//   to the amended values; the status follows what has been received (and an emergency order left fully received
//   asks for its review, F1-Q41).
// - returned or rejected: the PO leaves amendment_pending unchanged (back to issued, or to the received status).
// A PO that is not waiting for this decision is refused (409), never silently skipped.
// Round 5 (S3): once an approval commits, afterDecided enqueues the render of the version it wrote.
import type { ApprovalContext } from '@bos/contracts';
import {
  documents,
  purchaseOrders,
  purchaseOrderVersions,
  purchaseRequests,
  scoped,
  vendors,
} from '@bos/db';
import { Logger } from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { actorUuid, readTxContext } from '../../../platform/documents/tx-context';
import { fact, readableDocuments } from '../../approvals/context';
import type { ApprovalSubject, ApprovalsService } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../reference-names';
import { approvesRequestOf, mayReadPo, requestFactsColumns, requestOf } from './po-read-access';
import { PO_AMENDMENT_DOCUMENT_TYPE, PO_AUDIT_ENTITY } from './purchase-order.rules';
import type { PurchaseOrderRenderNudge } from './render/purchase-order-render.nudge';
import {
  drizzlePoVersionHeadLoader,
  PO_VERSION_OWNER_TYPE,
  PurchaseOrderVersionOwnerPolicy,
} from './render/purchase-order-version-owner.policy';
import {
  amendmentRequestOf,
  applyAmendment,
  conflict,
  linesOf,
  lockPo,
  receivedOf,
  settledStatus,
} from './purchase-order.writes';

type Outcome = 'approved' | 'returned' | 'rejected';

/** What afterDecided needs of the frozen proposal: the order and the version it amended. */
const AmendedOrderSchema = z.object({
  amendment: z.object({ purchaseOrderId: z.guid(), fromVersion: z.number().int().positive() }),
});

export class PoAmendmentSubject implements ApprovalSubject {
  readonly documentType = PO_AMENDMENT_DOCUMENT_TYPE;
  private readonly log = new Logger(PoAmendmentSubject.name);

  constructor(
    private readonly audit: AuditService,
    /** Asks for the review of an emergency purchase that the amendment leaves fully received (F1-Q41). */
    private readonly approvals: ApprovalsService,
    private readonly clock: () => Date = () => new Date(),
    /** Renders the approved version's PDF once the approval commits; absent, the render sweep draws it. */
    private readonly renderNudge?: PurchaseOrderRenderNudge,
  ) {}

  /**
   * After an approval commits: the version onDecided wrote (the amended one plus one) is rendered now rather than on
   * the next sweep. A snapshot that does not name the order is left to the sweep.
   */
  async afterDecided(decided: {
    scope: TxScope;
    outcome: Outcome;
    snapshot: unknown;
  }): Promise<void> {
    if (decided.outcome !== 'approved' || this.renderNudge === undefined) return;
    const parsed = AmendedOrderSchema.safeParse(decided.snapshot);
    if (!parsed.success) return;
    const { purchaseOrderId, fromVersion } = parsed.data.amendment;
    await this.renderNudge.nudge(decided.scope, purchaseOrderId, fromVersion + 1);
  }

  /** The order by number, its vendor by legal name and each amended line as "Line N: description". */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    const lines = (snapshot as { amendment?: { lines?: unknown } } | null)?.amendment?.lines;
    return procurementReferenceNames(q, scope, {
      purchaseOrderIds: [idAt(snapshot, 'amendment', 'purchaseOrderId')],
      vendorIds: [idAt(snapshot, 'vendorPartyId')],
      purchaseOrderLineIds: Array.isArray(lines) ? lines.map((line) => idAt(line, 'id')) : [],
    });
  }

  /**
   * The order as it stands now, with the PDF of its current version. The order page is linked only for a viewer the
   * order's detail route lets in (po-read-access.ts: procurement, and read-only the bill and receipt roles, F1-Q52,
   * and an approver of this amendment whose step is active or who decided one, R4f Q1 b); anyone else gets no link
   * rather than a page that refuses them (TR-Q2).
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string; snapshot: unknown },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const poId = idAt(request.snapshot, 'amendment', 'purchaseOrderId');
    if (poId === undefined) return null;
    const [po] = await q
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        status: purchaseOrders.status,
        currency: purchaseOrders.currency,
        approvedTotal: purchaseOrders.approvedTotal,
        currentVersion: purchaseOrders.currentVersion,
        vendorName: vendors.legalName,
        request: requestFactsColumns,
      })
      .from(purchaseOrders)
      .leftJoin(
        vendors,
        and(eq(vendors.tenantId, purchaseOrders.tenantId), eq(vendors.id, purchaseOrders.vendorId)),
      )
      .innerJoin(purchaseRequests, requestOf(purchaseOrders))
      .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, poId)));
    if (po === undefined) return null;
    const files = await q
      .select({ id: documents.id })
      .from(documents)
      .innerJoin(
        purchaseOrderVersions,
        and(
          eq(purchaseOrderVersions.tenantId, documents.tenantId),
          eq(purchaseOrderVersions.organizationId, documents.organizationId),
          eq(purchaseOrderVersions.id, documents.ownerId),
        ),
      )
      .where(
        scoped(scope).where(
          documents,
          and(
            eq(documents.ownerType, PO_VERSION_OWNER_TYPE),
            eq(purchaseOrderVersions.purchaseOrderId, po.id),
            eq(purchaseOrderVersions.version, po.currentVersion),
          ),
        ),
      );
    const linked =
      mayReadPo(viewer, po.request) ||
      (await approvesRequestOf(
        q,
        scope,
        viewer,
        { documentType: PO_AMENDMENT_DOCUMENT_TYPE, documentId: request.documentId },
        () => this.approvals.inbox(),
      ));
    return {
      title: `Purchase order ${po.number}`,
      fields: [
        ...fact.text('vendor', 'Vendor', po.vendorName),
        ...fact.text('currentVersion', 'Current version', String(po.currentVersion)),
        ...fact.money('approvedTotal', 'Approved total', po.approvedTotal, po.currency),
        ...fact.status(po.status),
      ],
      documents: await readableDocuments(
        q,
        scope,
        viewer,
        files.map((f) => f.id),
        [new PurchaseOrderVersionOwnerPolicy(drizzlePoVersionHeadLoader(q))],
      ),
      href: linked ? `/procurement/orders/${po.id}` : null,
    };
  }

  async onDecided(tx: DbTransaction, amendmentId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const now = this.clock();
    const { requestId, requesterUserId, proposal } = await amendmentRequestOf(
      tx,
      scope,
      amendmentId,
    );
    const po = await lockPo(tx, scope, proposal.purchaseOrderId);
    if (po.status !== 'amendment_pending') {
      this.log.error(`po ${po.id} is ${po.status}; refusing amendment outcome ${outcome}`);
      throw conflict('The purchase order is not waiting for an amendment decision');
    }
    if (outcome === 'approved') {
      await applyAmendment(
        tx,
        scope,
        { audit: this.audit, approvals: this.approvals },
        po,
        proposal,
        {
          approvalRequestId: requestId,
          createdBy: actorUuid(ctx) ?? requesterUserId,
          amendedBy: requesterUserId,
          now,
        },
      );
      return;
    }
    // amendment_pending → issued (PO_TRANSITIONS); from there the received quantities give the status.
    const status = settledStatus(
      await linesOf(tx, scope, po.id, true),
      await receivedOf(tx, scope, po.id),
    );
    await tx
      .update(purchaseOrders)
      .set({ status, version: sql`${purchaseOrders.version} + 1`, updatedAt: now })
      .where(
        scoped(scope).where(
          purchaseOrders,
          and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.status, 'amendment_pending')),
        ),
      );
    await this.audit.record(tx, {
      action: `procurement.po.amendment_${outcome}`,
      entityType: PO_AUDIT_ENTITY,
      entityId: po.id,
      before: { status: 'amendment_pending' },
      after: { status, approvalRequestId: requestId },
    });
  }

  /** The amendment is never cancelled through the engine by this module, so there is nothing to undo. */
  onCancelled(_tx: DbTransaction, _documentId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
