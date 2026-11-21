// The transaction steps purchase orders share between the service and the po_amendment approval subject (P4 unit
// P3): the row locks (PO first, then its lines, by line number), the received quantities, writing an immutable
// version, applying an amendment and settling the status after one. Every function runs inside the caller's
// transaction and scoped() to the acting entity, so another entity's PO is simply not found.
import {
  approvalRequests,
  paymentRequests,
  paymentTerms,
  purchaseOrderLines,
  purchaseOrderVersions,
  purchaseOrders,
  receiptLines,
  receipts,
  scoped,
  vendorAccounts,
  vendorBankAccounts,
  vendorBillSubmissions,
  vendorBills,
} from '@bos/db';
import { ConflictException, NotFoundException } from '@nestjs/common';
import Decimal from 'decimal.js';
import { and, asc, eq, ne, sql } from 'drizzle-orm';

import type { AuditService } from '../../../platform/audit/audit.service';
import type { DbTransaction } from '../../../platform/db/db.module';
import type { TxScope } from '../../../platform/db/tx';
import type { NumberingService } from '../../../platform/settings/numbering.service';
import type { ApprovalsService } from '../../approvals/requests.service';
import { emergencyReviewDue, requestEmergencyReview } from '../receipts/emergency-review';
import { derivePoStatus } from '../receipts/receipt.rules';
import { PO_SERIES } from '../sourcing/sourcing.rules';
import {
  PO_AMENDMENT_DOCUMENT_TYPE,
  PO_AUDIT_ENTITY,
  PO_REFERENCED,
  type AmendedLine,
} from './purchase-order.rules';

export type PoRow = typeof purchaseOrders.$inferSelect;
export type PoLineRow = typeof purchaseOrderLines.$inferSelect;

export const notFound = () =>
  new NotFoundException({ code: 'not_found', message: 'Purchase order not found' });
export const conflict = (message: string, code = 'conflict') =>
  new ConflictException({ code, message });

/** What an amendment changes; also the `amendment` part of the approval snapshot of a re-approved one. */
export interface AmendmentProposal {
  purchaseOrderId: string;
  purchaseOrderNumber: string;
  /** The version being amended; applying fails when the PO moved on in the meantime. */
  fromVersion: number;
  reason: string;
  paymentTermsDays: number;
  currency: string;
  lines: AmendedLine[];
  total: string;
  totalNpr: string;
  band: 'base' | 'management' | 'founder';
}

export async function lockPo(tx: DbTransaction, scope: TxScope, id: string): Promise<PoRow> {
  const [po] = await tx
    .select()
    .from(purchaseOrders)
    .where(scoped(scope).where(purchaseOrders, eq(purchaseOrders.id, id)))
    .for('update');
  if (po === undefined) throw notFound();
  return po;
}

/**
 * The payment terms (net days) of the vendor's account in the acting entity, 0 when it names none: the same lookup
 * insertDraftPurchaseOrder (sourcing/pr-commitment.subject.ts) makes for a commitment draft.
 */
export async function vendorTermsDays(
  tx: DbTransaction,
  scope: TxScope,
  vendorId: string,
): Promise<number> {
  const [terms] = await tx
    .select({ netDays: paymentTerms.netDays })
    .from(vendorAccounts)
    .leftJoin(
      paymentTerms,
      and(
        eq(paymentTerms.tenantId, vendorAccounts.tenantId),
        eq(paymentTerms.id, vendorAccounts.paymentTermId),
      ),
    )
    .where(scoped(scope).where(vendorAccounts, eq(vendorAccounts.vendorId, vendorId)));
  return terms?.netDays ?? 0;
}

/**
 * 409 VENDOR_NO_VERIFIED_BANK_ACCOUNT unless the vendor has an `active` bank account, the row
 * VendorBankService.activeVerifiedAccount reads for a payment request (an active account is verified by another
 * person with call-back evidence: vendor_bank_accounts_active_check). Bank accounts are tenant level.
 */
export async function assertVerifiedBankAccount(
  tx: DbTransaction,
  scope: TxScope,
  vendorId: string,
): Promise<void> {
  const [row] = await tx
    .select({ id: vendorBankAccounts.id })
    .from(vendorBankAccounts)
    .where(
      and(
        eq(vendorBankAccounts.tenantId, scope.tenantId),
        eq(vendorBankAccounts.vendorId, vendorId),
        eq(vendorBankAccounts.status, 'active'),
      ),
    );
  if (row === undefined) {
    throw conflict('The vendor has no verified bank account', 'VENDOR_NO_VERIFIED_BANK_ACCOUNT');
  }
}

/**
 * 409 PO_REFERENCED when a payment request, vendor bill or portal bill submission names the PO, in any status (a
 * cancelled or voided row still holds its foreign key). Each refers to the PO together with its vendor
 * (payment_requests_purchase_order_fk, vendor_bills_purchase_order_fk, vendor_bill_submissions_purchase_order_fk), so
 * changing the vendor would fail on the key. Call it after lockPo: the PO's row lock blocks a concurrent insert that
 * names it until this transaction ends.
 */
export async function assertPoNotReferenced(
  tx: DbTransaction,
  scope: TxScope,
  poId: string,
): Promise<void> {
  const s = scoped(scope);
  const [request] = await tx
    .select({ id: paymentRequests.id })
    .from(paymentRequests)
    .where(s.where(paymentRequests, eq(paymentRequests.purchaseOrderId, poId)))
    .limit(1);
  const [bill] = await tx
    .select({ id: vendorBills.id })
    .from(vendorBills)
    .where(s.where(vendorBills, eq(vendorBills.purchaseOrderId, poId)))
    .limit(1);
  const [submission] = await tx
    .select({ id: vendorBillSubmissions.id })
    .from(vendorBillSubmissions)
    .where(s.where(vendorBillSubmissions, eq(vendorBillSubmissions.purchaseOrderId, poId)))
    .limit(1);
  if (request !== undefined || bill !== undefined || submission !== undefined) {
    throw conflict(PO_REFERENCED.message, PO_REFERENCED.code);
  }
}

export async function linesOf(
  tx: DbTransaction,
  scope: TxScope,
  poId: string,
  lock: boolean,
): Promise<PoLineRow[]> {
  const q = tx
    .select()
    .from(purchaseOrderLines)
    .where(scoped(scope).where(purchaseOrderLines, eq(purchaseOrderLines.purchaseOrderId, poId)))
    .orderBy(asc(purchaseOrderLines.lineNo));
  return lock ? q.for('update') : q;
}

export interface Received {
  /** Net of every receipt line, whatever its status (what receipt_lines_guard counts). */
  all: Map<string, string>;
  /** Net of confirmed and reversed receipts (what the PO status follows). */
  confirmed: Map<string, string>;
  hasDraft: boolean;
  any: boolean;
}

export async function receivedOf(
  tx: DbTransaction,
  scope: TxScope,
  poId: string,
): Promise<Received> {
  const rows = await tx
    .select({
      poLineId: receiptLines.poLineId,
      quantity: receiptLines.quantity,
      status: receipts.status,
    })
    .from(receiptLines)
    .innerJoin(
      receipts,
      and(
        eq(receipts.tenantId, receiptLines.tenantId),
        eq(receipts.organizationId, receiptLines.organizationId),
        eq(receipts.id, receiptLines.receiptId),
      ),
    )
    .where(
      scoped(scope).where(
        receiptLines,
        and(eq(receiptLines.purchaseOrderId, poId), ne(receipts.status, 'discarded')),
      ),
    );
  const all = new Map<string, Decimal>();
  const confirmed = new Map<string, Decimal>();
  for (const r of rows) {
    all.set(r.poLineId, (all.get(r.poLineId) ?? new Decimal(0)).plus(r.quantity));
    if (r.status !== 'draft') {
      confirmed.set(r.poLineId, (confirmed.get(r.poLineId) ?? new Decimal(0)).plus(r.quantity));
    }
  }
  const fmt = (m: Map<string, Decimal>) =>
    new Map([...m].map(([k, v]) => [k, v.toFixed(4)] as [string, string]));
  return {
    all: fmt(all),
    confirmed: fmt(confirmed),
    hasDraft: rows.some((r) => r.status === 'draft'),
    any: rows.length > 0,
  };
}

/** The status the confirmed quantities give (issued, partially_received or fully_received). */
export function settledStatus(lines: readonly PoLineRow[], received: Received) {
  return derivePoStatus(
    lines.map((l) => ({
      orderedQuantity: l.orderedQuantity,
      cancelledQuantity: l.cancelledQuantity,
      receivedQuantity: received.confirmed.get(l.id) ?? '0',
    })),
  );
}

/** The full snapshot of a version: the header and every line, as they stand. */
export function snapshotOf(po: PoRow, lines: readonly PoLineRow[]) {
  return {
    purchaseOrder: {
      id: po.id,
      number: po.number,
      purchaseRequestId: po.purchaseRequestId,
      vendorId: po.vendorId,
      currency: po.currency,
      paymentTermsDays: po.paymentTermsDays,
      advancePercent: po.advancePercent,
      fxRate: po.fxRate,
      fxSource: po.fxSource,
      fxDate: po.fxDate,
    },
    lines: lines.map((l) => ({
      id: l.id,
      lineNo: l.lineNo,
      prLineId: l.prLineId,
      kind: l.kind,
      description: l.description,
      uom: l.uom,
      orderedQuantity: l.orderedQuantity,
      cancelledQuantity: l.cancelledQuantity,
      unitPrice: l.unitPrice,
      taxCodeId: l.taxCodeId,
      gross: l.gross,
      taxAmount: l.taxAmount,
      lineTotal: l.lineTotal,
    })),
  };
}

/**
 * Writes version `version` of the PO (immutable once written). The PDF render is a later unit: it finds issued
 * versions that have no document (owner_type purchase_order_version) and renders them, so nothing is queued here.
 */
export async function insertVersion(
  tx: DbTransaction,
  scope: TxScope,
  i: {
    po: PoRow;
    lines: readonly PoLineRow[];
    version: number;
    reason: string | null;
    total: string;
    totalNpr: string;
    band: 'base' | 'management' | 'founder';
    approvalRequestId: string | null;
    createdBy: string;
  },
): Promise<void> {
  await tx.insert(purchaseOrderVersions).values({
    ...scope,
    purchaseOrderId: i.po.id,
    version: i.version,
    reason: i.reason,
    total: i.total,
    totalNpr: i.totalNpr,
    band: i.band,
    snapshot: snapshotOf(i.po, i.lines),
    approvalRequestId: i.approvalRequestId,
    createdBy: i.createdBy,
  });
}

/**
 * Applies an amendment to a PO locked by the caller: the lines take the new quantities and prices, version N+1 is
 * written with its totals and band, and the status follows what has been received. A re-approved amendment
 * (approvalRequestId set) also moves approved_total, approved_total_npr and approved_band (AD7). An amendment that
 * leaves an emergency order fully received (its quantity lowered to what arrived) asks for its review (F1-Q41).
 * `amendedBy` is who proposed the amendment; `createdBy` writes the version (the approver, once approved).
 */
export async function applyAmendment(
  tx: DbTransaction,
  scope: TxScope,
  deps: { audit: AuditService; approvals: ApprovalsService },
  po: PoRow,
  p: AmendmentProposal,
  by: { approvalRequestId: string | null; createdBy: string; amendedBy: string; now: Date },
): Promise<PoRow> {
  if (po.currentVersion !== p.fromVersion) {
    throw conflict(`The purchase order is at version ${po.currentVersion}, not ${p.fromVersion}`);
  }
  await linesOf(tx, scope, po.id, true);
  for (const l of p.lines) {
    await tx
      .update(purchaseOrderLines)
      .set({
        orderedQuantity: l.orderedQuantity,
        unitPrice: l.unitPrice,
        gross: l.gross,
        taxAmount: l.taxAmount,
        lineTotal: l.lineTotal,
        updatedAt: by.now,
      })
      .where(
        scoped(scope).where(
          purchaseOrderLines,
          and(eq(purchaseOrderLines.id, l.id), eq(purchaseOrderLines.purchaseOrderId, po.id)),
        ),
      );
  }
  const lines = await linesOf(tx, scope, po.id, false);
  const status = settledStatus(lines, await receivedOf(tx, scope, po.id));
  const version = po.currentVersion + 1;
  const approved = by.approvalRequestId !== null;
  const [row] = await tx
    .update(purchaseOrders)
    .set({
      status,
      currentVersion: version,
      paymentTermsDays: p.paymentTermsDays,
      ...(approved
        ? { approvedTotal: p.total, approvedTotalNpr: p.totalNpr, approvedBand: p.band }
        : {}),
      version: sql`${purchaseOrders.version} + 1`,
      updatedAt: by.now,
    })
    .where(
      scoped(scope).where(
        purchaseOrders,
        and(eq(purchaseOrders.id, po.id), eq(purchaseOrders.currentVersion, p.fromVersion)),
      ),
    )
    .returning();
  if (row === undefined) throw conflict('The purchase order changed while it was being amended');
  await insertVersion(tx, scope, {
    po: row,
    lines,
    version,
    reason: p.reason,
    total: p.total,
    totalNpr: p.totalNpr,
    band: p.band,
    approvalRequestId: by.approvalRequestId,
    createdBy: by.createdBy,
  });
  await deps.audit.record(tx, {
    action: 'procurement.po.amended',
    entityType: PO_AUDIT_ENTITY,
    entityId: po.id,
    before: {
      version: po.currentVersion,
      status: po.status,
      approvedBand: po.approvedBand,
      approvedTotalNpr: po.approvedTotalNpr,
    },
    after: {
      version,
      status,
      total: p.total,
      totalNpr: p.totalNpr,
      band: p.band,
      approvalRequestId: by.approvalRequestId,
      reason: p.reason,
    },
  });
  if (emergencyReviewDue(po.status, status)) {
    await requestEmergencyReview(tx, scope, deps, row, by.amendedBy);
  }
  return row;
}

/**
 * Writes a new draft PO cloned from `from` (cancel and recreate): the same request, RFQ, quotation, vendor, money
 * terms, approved total, rate and band, with a new number from the PO series and `createdBy` as its author; version 0,
 * not issued. Its lines copy `lines` in their order with the ordered quantities and nothing cancelled. The caller
 * cancels `from` first in the same transaction: the one-live-PO-per-quotation index
 * (purchase_orders_tenant_quotation_live_unique) only lets the clone in once `from` is cancelled. The number is taken
 * last before the insert (the numbering row lock), as insertDraftPurchaseOrder does.
 */
export async function insertRecreatedDraft(
  tx: DbTransaction,
  scope: TxScope,
  numbering: NumberingService,
  from: PoRow,
  lines: readonly PoLineRow[],
  createdBy: string,
  now: Date,
): Promise<{ po: PoRow; lines: PoLineRow[] }> {
  const issued = await numbering.issue(tx, PO_SERIES, now);
  const [po] = await tx
    .insert(purchaseOrders)
    .values({
      ...scope,
      number: issued.number,
      numberSeq: issued.seq,
      fiscalYear: issued.fiscalYear,
      purchaseRequestId: from.purchaseRequestId,
      rfqId: from.rfqId,
      vendorQuotationId: from.vendorQuotationId,
      vendorId: from.vendorId,
      currency: from.currency,
      paymentTermsDays: from.paymentTermsDays,
      advancePercent: from.advancePercent,
      approvedTotal: from.approvedTotal,
      fxRate: from.fxRate,
      fxSource: from.fxSource,
      fxDate: from.fxDate,
      approvedTotalNpr: from.approvedTotalNpr,
      approvedBand: from.approvedBand,
      createdBy,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  if (lines.length === 0) return { po: po!, lines: [] };
  const cloned = await tx
    .insert(purchaseOrderLines)
    .values(
      lines.map((l) => ({
        ...scope,
        purchaseOrderId: po!.id,
        purchaseRequestId: from.purchaseRequestId,
        lineNo: l.lineNo,
        prLineId: l.prLineId,
        kind: l.kind,
        description: l.description,
        uom: l.uom,
        orderedQuantity: l.orderedQuantity,
        cancelledQuantity: '0',
        unitPrice: l.unitPrice,
        taxCodeId: l.taxCodeId,
        gross: l.gross,
        taxAmount: l.taxAmount,
        lineTotal: l.lineTotal,
        requiresSerials: l.requiresSerials,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .returning();
  return { po: po!, lines: [...cloned].sort((a, b) => a.lineNo - b.lineNo) };
}

/** The approval request of a re-approved amendment and the proposal it carries; 409 when it is missing. */
export async function amendmentRequestOf(
  tx: DbTransaction,
  scope: TxScope,
  amendmentId: string,
): Promise<{ requestId: string; requesterUserId: string; proposal: AmendmentProposal }> {
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
          eq(approvalRequests.documentType, PO_AMENDMENT_DOCUMENT_TYPE),
          eq(approvalRequests.documentId, amendmentId),
        ),
      ),
    );
  const proposal = (req?.snapshot as { amendment?: AmendmentProposal } | undefined)?.amendment;
  if (req === undefined || proposal === undefined)
    throw conflict('The amendment request is missing');
  return { requestId: req.id, requesterUserId: req.requesterUserId, proposal };
}
