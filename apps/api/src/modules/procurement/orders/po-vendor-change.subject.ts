// The po_vendor_change approval subject (K3 Q1 b): what a decided vendor change does to its draft PO, in the deciding
// transaction (ApprovalsService.act), so the decision and its effects commit or roll back together.
// A swap of vendor whose quotation total differs from the total the order was approved at goes through the commitment
// route again before it can be issued. The document id is the change's own id (a fresh uuid), the frozen proposal is
// the `vendorChange` part of the request's snapshot, and the order itself is untouched until the decision.
// - approved: the change is written (lines, prices, rate, total, band and vendor of the new quotation).
// - returned or rejected: the order stays as it was and can be issued, or changed again.
// A draft that moved on since the request (not a draft any more, or edited) is refused (409), never silently skipped.
import type { ApprovalContext } from '@bos/contracts';
import { purchaseOrders, purchaseRequests, scoped, vendorQuotations, vendors } from '@bos/db';
import { Logger } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Principal } from '../../../platform/authz/principal';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { readTxContext } from '../../../platform/documents/tx-context';
import { fact } from '../../approvals/context';
import type { ApprovalSubject, ApprovalsService } from '../../approvals/requests.service';
import { idAt, procurementReferenceNames } from '../reference-names';
import { approvesRequestOf, mayReadPo, requestFactsColumns, requestOf } from './po-read-access';
import { applyVendorChange, vendorChangeRequestOf } from './po-vendor-change.writes';
import { PO_VENDOR_CHANGE_DOCUMENT_TYPE } from './po-vendor-change.rules';
import { PO_AUDIT_ENTITY } from './purchase-order.rules';
import { assertPoNotReferenced, conflict, lockPo } from './purchase-order.writes';

type Outcome = 'approved' | 'returned' | 'rejected';

export class PoVendorChangeSubject implements ApprovalSubject {
  readonly documentType = PO_VENDOR_CHANGE_DOCUMENT_TYPE;
  private readonly log = new Logger(PoVendorChangeSubject.name);

  constructor(
    private readonly audit: AuditService,
    private readonly approvals: ApprovalsService,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  /** The order by number and both vendors by legal name. */
  referenceNames(q: Db, scope: TxScope, snapshot: unknown) {
    return procurementReferenceNames(q, scope, {
      purchaseOrderIds: [idAt(snapshot, 'vendorChange', 'purchaseOrderId')],
      vendorIds: [
        idAt(snapshot, 'vendorChange', 'vendorId'),
        idAt(snapshot, 'vendorChange', 'fromVendorId'),
      ],
    });
  }

  /**
   * The order as it stands now, with the new vendor's quotation total. The order page is linked only for a viewer
   * the order's detail route lets in (procurement, read-only roles, or an approver of this change).
   */
  async context(
    q: Db,
    scope: TxScope,
    request: { documentId: string; snapshot: unknown },
    viewer: Principal,
  ): Promise<ApprovalContext | null> {
    const poId = idAt(request.snapshot, 'vendorChange', 'purchaseOrderId');
    const quoteId = idAt(request.snapshot, 'vendorChange', 'vendorQuotationId');
    if (poId === undefined) return null;
    const [po] = await q
      .select({
        id: purchaseOrders.id,
        number: purchaseOrders.number,
        status: purchaseOrders.status,
        currency: purchaseOrders.currency,
        approvedTotal: purchaseOrders.approvedTotal,
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
    const [quote] =
      quoteId === undefined
        ? []
        : await q
            .select({ total: vendorQuotations.total, currency: vendorQuotations.currency })
            .from(vendorQuotations)
            .where(scoped(scope).where(vendorQuotations, eq(vendorQuotations.id, quoteId)));
    const linked =
      mayReadPo(viewer, po.request) ||
      (await approvesRequestOf(
        q,
        scope,
        viewer,
        { documentType: PO_VENDOR_CHANGE_DOCUMENT_TYPE, documentId: request.documentId },
        () => this.approvals.inbox(),
      ));
    return {
      title: `Purchase order ${po.number}`,
      fields: [
        ...fact.text('vendor', 'Current vendor', po.vendorName),
        ...fact.money('approvedTotal', 'Approved total', po.approvedTotal, po.currency),
        ...(quote === undefined
          ? []
          : fact.money('newTotal', 'New vendor quotation total', quote.total, quote.currency)),
        ...fact.status(po.status),
      ],
      documents: [],
      href: linked ? `/procurement/orders/${po.id}` : null,
    };
  }

  async onDecided(tx: DbTransaction, changeId: string, outcome: Outcome): Promise<void> {
    const ctx = await readTxContext(tx);
    const { scope } = ctx;
    const now = this.clock();
    const { requestId, proposal } = await vendorChangeRequestOf(tx, scope, changeId);
    const po = await lockPo(tx, scope, proposal.purchaseOrderId);
    if (po.status !== 'draft' || po.vendorId !== proposal.fromVendorId) {
      this.log.error(`po ${po.id} is ${po.status}; refusing vendor change outcome ${outcome}`);
      throw conflict('The purchase order is not waiting for a vendor change decision');
    }
    if (outcome !== 'approved') {
      await this.audit.record(tx, {
        action: `procurement.po.vendor_change_${outcome}`,
        entityType: PO_AUDIT_ENTITY,
        entityId: po.id,
        before: { vendorId: po.vendorId },
        after: { vendorId: proposal.vendorId, approvalRequestId: requestId },
      });
      return;
    }
    // A payment request, bill or portal submission raised on the draft while this waited holds a key on its vendor.
    await assertPoNotReferenced(tx, scope, po.id);
    const [quote] = await tx
      .select()
      .from(vendorQuotations)
      .where(
        scoped(scope).where(vendorQuotations, eq(vendorQuotations.id, proposal.vendorQuotationId)),
      );
    if (quote === undefined) throw conflict('The new vendor quotation is missing');
    await applyVendorChange(tx, scope, this.audit, po, quote, {
      now,
      approvalRequestId: requestId,
      expectedVersion: proposal.fromVersion,
      vatWarningAcknowledged: proposal.vatWarningAcknowledged,
    });
  }

  /** The change is never cancelled through the engine by this module, so there is nothing to undo. */
  onCancelled(_tx: DbTransaction, _documentId: string, _reason: string): Promise<void> {
    return Promise.resolve();
  }
}
