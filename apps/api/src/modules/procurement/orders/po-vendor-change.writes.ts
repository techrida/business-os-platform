// The transaction steps of a vendor change on a draft PO (K3 Q1 b, Q2), shared by PurchaseOrdersService (a change
// applied at once, or submitted for approval) and the po_vendor_change approval subject (a change applied on approval).
// Every function runs inside the caller's transaction and scoped() to the acting entity.
// The new vendor is only ever taken from its OWN quotation on the order's RFQ: its lines, prices, total, rate and
// band replace the old vendor's, so nothing the commitment approved for another vendor carries over.
import {
  purchaseOrderLines,
  purchaseOrders,
  purchaseRequestLines,
  purchaseRequests,
  scoped,
  vendorBankAccounts,
  vendorQuotationLines,
  vendorQuotations,
  vendors,
  approvalRequests,
} from '@bos/db';
import Decimal from 'decimal.js';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { Db, DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import { poBandOf } from '../sourcing/sourcing.rules';
import { PO_VENDOR_CHANGE_DOCUMENT_TYPE } from './po-vendor-change.rules';
import { PO_AUDIT_ENTITY } from './purchase-order.rules';
import { conflict, vendorTermsDays, type PoLineRow, type PoRow } from './purchase-order.writes';

export type QuotationRow = typeof vendorQuotations.$inferSelect;

/** What a vendor-change approval freezes; the `vendorChange` part of the request's snapshot. */
export interface VendorChangeProposal {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  /** The order's `version` when the change was asked for; applying on approval fails when it moved on. */
  fromVersion: number;
  fromVendorId: string;
  fromTotal: string;
  vendorId: string;
  vendorName: string | null;
  vendorQuotationId: string;
  currency: string;
  total: string;
  totalNpr: string;
  band: 'base' | 'management' | 'founder';
  vatWarningAcknowledged: boolean;
}

/**
 * The lines a draft PO gets from its recommended quotation: one per line of the quotation, with the request line's
 * description, unit and serial rule. Read-only; the writers below store them, and the detail of a draft that has none
 * yet shows them as the lines it will be issued with.
 */
export async function quotationLinesOf(
  q: Db | DbTransaction,
  scope: TxScope,
  po: Pick<PoRow, 'vendorQuotationId' | 'purchaseRequestId'>,
  quotationId: string | null = po.vendorQuotationId,
) {
  if (quotationId === null) return [];
  const [pr] = await q
    .select({ requestType: purchaseRequests.requestType })
    .from(purchaseRequests)
    .where(scoped(scope).where(purchaseRequests, eq(purchaseRequests.id, po.purchaseRequestId)));
  const rows = await q
    .select({ q: vendorQuotationLines, pr: purchaseRequestLines })
    .from(vendorQuotationLines)
    .innerJoin(
      purchaseRequestLines,
      and(
        eq(purchaseRequestLines.tenantId, vendorQuotationLines.tenantId),
        eq(purchaseRequestLines.organizationId, vendorQuotationLines.organizationId),
        eq(purchaseRequestLines.id, vendorQuotationLines.prLineId),
      ),
    )
    .where(
      scoped(scope).where(
        vendorQuotationLines,
        eq(vendorQuotationLines.vendorQuotationId, quotationId),
      ),
    )
    .orderBy(asc(purchaseRequestLines.lineNo));
  // A request line has no kind of its own: a service request gives service lines, any other gives goods.
  const kind: 'goods' | 'service' = pr?.requestType === 'service' ? 'service' : 'goods';
  return rows.map((r, i) => ({
    quotationLineId: r.q.id,
    lineNo: i + 1,
    prLineId: r.pr.id,
    kind,
    requiresSerials: kind === 'goods' && r.pr.requiresSerials,
    description: r.pr.description,
    uom: r.pr.uom,
    orderedQuantity: r.q.quantity,
    unitPrice: r.q.unitPrice,
    taxCodeId: r.q.taxCodeId,
    gross: r.q.gross,
    taxAmount: r.q.taxAmount,
    lineTotal: r.q.lineTotal,
  }));
}

/**
 * The quotation the new vendor recorded on the order's RFQ, after the refusals of K3 Q1 and Q2 that depend on it:
 * - 409 PO_VENDOR_CHANGE_NO_RFQ: the draft has no RFQ link, so there is no quotation to take ("create a new PO");
 * - 409 PO_VENDOR_NO_QUOTATION: the new vendor has no quotation on that RFQ;
 * - 409 VENDOR_CURRENCY_NOT_SUPPORTED: the quotation is not in the order's currency, or the vendor has no verified
 *   bank account in it (the order cannot be paid to this vendor in that currency).
 */
export async function vendorChangeQuotation(
  tx: DbTransaction,
  scope: TxScope,
  po: PoRow,
  vendorId: string,
): Promise<QuotationRow> {
  if (po.rfqId === null) {
    throw conflict(
      'This draft is not linked to an RFQ, so the new vendor has no quotation to take. Create a new purchase order for this vendor instead.',
      'PO_VENDOR_CHANGE_NO_RFQ',
    );
  }
  const [quote] = await tx
    .select()
    .from(vendorQuotations)
    .where(
      scoped(scope).where(
        vendorQuotations,
        and(eq(vendorQuotations.rfqId, po.rfqId), eq(vendorQuotations.vendorId, vendorId)),
      ),
    );
  if (quote === undefined) {
    throw conflict(
      "The new vendor has no quotation on this order's RFQ. Record its quotation first, or create a new purchase order.",
      'PO_VENDOR_NO_QUOTATION',
    );
  }
  const [bank] = await tx
    .select({ id: vendorBankAccounts.id })
    .from(vendorBankAccounts)
    .where(
      and(
        eq(vendorBankAccounts.tenantId, scope.tenantId),
        eq(vendorBankAccounts.vendorId, vendorId),
        eq(vendorBankAccounts.status, 'active'),
        eq(vendorBankAccounts.currency, po.currency),
      ),
    );
  if (quote.currency !== po.currency || bank === undefined) {
    throw conflict(
      `The new vendor cannot trade in ${po.currency}: its quotation is in ${quote.currency}${
        bank === undefined ? ` and it has no verified ${po.currency} bank account` : ''
      }.`,
      'VENDOR_CURRENCY_NOT_SUPPORTED',
    );
  }
  return quote;
}

/**
 * True when the order carries VAT (a line with tax) and the vendor is not VAT registered: the soft warning of K3 Q2.
 * The caller needs the person's acknowledgement before it goes on; nothing is refused.
 */
export async function vatWarningFor(
  tx: DbTransaction,
  scope: TxScope,
  quote: QuotationRow,
  vendorId: string,
): Promise<boolean> {
  if (new Decimal(quote.taxAmount).isZero()) return false;
  const [vendor] = await tx
    .select({ vatRegistered: vendors.vatRegistered })
    .from(vendors)
    .where(and(eq(vendors.tenantId, scope.tenantId), eq(vendors.id, vendorId)));
  return vendor?.vatRegistered !== true;
}

/**
 * True when the quotation may replace the order without a new approval: its total equals the total the order was
 * approved at AND its NPR value is no higher. Each quotation carries the rate of the day it was recorded, so two
 * quotations of one total can differ in NPR, and the NPR value picks the approval band (AD4): a higher one needs the
 * route again.
 */
export const sameApprovedTotal = (
  po: Pick<PoRow, 'approvedTotal' | 'approvedTotalNpr'>,
  quote: Pick<QuotationRow, 'total' | 'totalNpr'>,
) =>
  new Decimal(po.approvedTotal).equals(new Decimal(quote.total)) &&
  new Decimal(quote.totalNpr).lte(new Decimal(po.approvedTotalNpr));

export function proposalOf(
  po: PoRow,
  quote: QuotationRow,
  vendorName: string | null,
  vatWarningAcknowledged: boolean,
): VendorChangeProposal {
  return {
    purchaseOrderId: po.id,
    purchaseOrderNumber: po.number,
    fromVersion: po.version,
    fromVendorId: po.vendorId,
    fromTotal: po.approvedTotal,
    vendorId: quote.vendorId,
    vendorName,
    vendorQuotationId: quote.id,
    currency: quote.currency,
    total: quote.total,
    totalNpr: quote.totalNpr,
    band: poBandOf(quote.totalNpr),
    vatWarningAcknowledged,
  };
}

/**
 * Writes the vendor change: the old lines are replaced by the new vendor's quotation lines, and the vendor, its
 * account's payment terms, a zero advance, the quotation link, the rate and the approved total, NPR total and band
 * follow the new quotation. The RFQ link stays. Conditional on the draft (status and version), 409 otherwise.
 */
export async function applyVendorChange(
  tx: DbTransaction,
  scope: TxScope,
  audit: AuditService,
  po: PoRow,
  quote: QuotationRow,
  ctx: {
    now: Date;
    approvalRequestId: string | null;
    expectedVersion: number;
    vatWarningAcknowledged: boolean;
  },
): Promise<{ row: PoRow; lines: PoLineRow[] }> {
  if (po.status !== 'draft' || po.version !== ctx.expectedVersion) {
    throw conflict('The purchase order changed while its vendor was changed');
  }
  const proposed = await quotationLinesOf(tx, scope, po, quote.id);
  if (proposed.length === 0) throw conflict('The purchase order has no lines', 'PO_HAS_NO_LINES');
  await tx
    .delete(purchaseOrderLines)
    .where(scoped(scope).where(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, po.id)));
  const lines = await tx
    .insert(purchaseOrderLines)
    .values(
      proposed.map(({ quotationLineId: _q, ...l }) => ({
        ...scope,
        ...l,
        purchaseOrderId: po.id,
        purchaseRequestId: po.purchaseRequestId,
        createdAt: ctx.now,
        updatedAt: ctx.now,
      })),
    )
    .returning();
  const set = {
    vendorId: quote.vendorId,
    paymentTermsDays: await vendorTermsDays(tx, scope, quote.vendorId),
    advancePercent: '0',
    vendorQuotationId: quote.id,
    approvedTotal: quote.total,
    fxRate: quote.fxRate,
    fxSource: quote.fxSource,
    fxDate: quote.fxDate,
    approvedTotalNpr: quote.totalNpr,
    approvedBand: poBandOf(quote.totalNpr),
  };
  const [row] = await tx
    .update(purchaseOrders)
    .set({ ...set, version: sql`${purchaseOrders.version} + 1`, updatedAt: ctx.now })
    .where(
      scoped(scope).where(
        purchaseOrders,
        and(
          eq(purchaseOrders.id, po.id),
          eq(purchaseOrders.status, 'draft'),
          eq(purchaseOrders.version, ctx.expectedVersion),
        ),
      ),
    )
    .returning();
  if (row === undefined) throw conflict('The purchase order changed while its vendor was changed');
  await audit.record(tx, {
    action: 'procurement.po.vendor_changed',
    entityType: PO_AUDIT_ENTITY,
    entityId: po.id,
    before: {
      vendorId: po.vendorId,
      paymentTermsDays: po.paymentTermsDays,
      advancePercent: po.advancePercent,
      vendorQuotationId: po.vendorQuotationId,
      approvedTotal: po.approvedTotal,
    },
    after: {
      ...set,
      linesWritten: lines.length,
      approvalRequestId: ctx.approvalRequestId,
      vatWarningAcknowledged: ctx.vatWarningAcknowledged,
    },
  });
  return { row, lines };
}

/**
 * The open vendor-change approval of a draft, if any: the order cannot be issued, or changed again, until it is
 * decided. Reads the frozen proposal from the request's snapshot.
 */
export async function pendingVendorChangeOf(
  q: Db | DbTransaction,
  scope: TxScope,
  poId: string,
): Promise<{ approvalRequestId: string; vendorId: string; total: string } | null> {
  const [req] = await q
    .select({ id: approvalRequests.id, snapshot: approvalRequests.snapshot })
    .from(approvalRequests)
    .where(
      scoped(scope).where(
        approvalRequests,
        and(
          eq(approvalRequests.documentType, PO_VENDOR_CHANGE_DOCUMENT_TYPE),
          inArray(approvalRequests.status, ['pending', 'blocked']),
          sql`${approvalRequests.snapshot} -> 'vendorChange' ->> 'purchaseOrderId' = ${poId}`,
        ),
      ),
    )
    .limit(1);
  if (req === undefined) return null;
  const p = (req.snapshot as { vendorChange?: VendorChangeProposal }).vendorChange;
  return { approvalRequestId: req.id, vendorId: p?.vendorId ?? '', total: p?.total ?? '' };
}

/** 409 PO_VENDOR_CHANGE_PENDING while a vendor change of the order waits for its approval. */
export async function assertNoPendingVendorChange(
  tx: DbTransaction,
  scope: TxScope,
  poId: string,
): Promise<void> {
  if ((await pendingVendorChangeOf(tx, scope, poId)) !== null) {
    throw conflict(
      'A change of vendor on this order is waiting for approval. It can be issued once that is decided.',
      'PO_VENDOR_CHANGE_PENDING',
    );
  }
}

/** The request of a vendor change by its document id, with the frozen proposal. */
export async function vendorChangeRequestOf(
  tx: DbTransaction,
  scope: TxScope,
  changeId: string,
): Promise<{ requestId: string; requesterUserId: string; proposal: VendorChangeProposal }> {
  const [req] = await tx
    .select({
      id: approvalRequests.id,
      requesterUserId: approvalRequests.requesterUserId,
      snapshot: approvalRequests.snapshot,
    })
    .from(approvalRequests)
    .where(
      scoped(scope).where(
        approvalRequests,
        and(
          eq(approvalRequests.documentType, PO_VENDOR_CHANGE_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, changeId),
        ),
      ),
    );
  const proposal = (req?.snapshot as { vendorChange?: VendorChangeProposal } | undefined)
    ?.vendorChange;
  if (req === undefined || proposal === undefined)
    throw conflict('The vendor change request is missing');
  return { requestId: req.id, requesterUserId: req.requesterUserId, proposal };
}
