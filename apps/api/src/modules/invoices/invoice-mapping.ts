// Maps invoice rows to the contract DTOs (P3 unit U10). Field by field: nothing is spread, so a column added to the
// table later never reaches a client until it is named here. Serves the NFR "paid is derived": there is no paid field
// to map (plan A8). Money stays text; the content hash is hex; the NPR value exists only once frozen at issue.
import {
  DocumentFormatSnapshotSchema,
  isInvoiceEditable,
  PartySnapshotSchema,
  type DocumentFormatSnapshot,
  type InvoiceCan,
  type InvoiceDetail,
  type InvoiceDto,
  type InvoiceLineDto,
  type InvoiceListItem,
  type InvoiceTaxSummaryItem,
  type Permission,
} from '@bos/contracts';
import type { invoiceLines, invoicePrintLog, invoices, invoiceTaxSummary } from '@bos/db';
import { Dec, allocateLargestRemainder } from '@bos/money-rules';

import { can, type Principal } from '../../platform/authz/can';
import type { TxScope } from '../../platform/db/tx';

export type InvoiceRow = typeof invoices.$inferSelect;
export type InvoiceLineRow = typeof invoiceLines.$inferSelect;
export type InvoiceTaxSummaryRow = typeof invoiceTaxSummary.$inferSelect;
export type InvoicePrintRow = typeof invoicePrintLog.$inferSelect;

function nprOf(row: InvoiceRow): InvoiceDto['npr'] {
  const rateDate = row.fxDate ?? row.issueDate;
  if (row.fxRate === null || row.amountNpr === null || rateDate === null) return null;
  return {
    amountNpr: row.amountNpr,
    rate: row.fxRate,
    rateSource: row.fxSource ?? 'NPR',
    rateDate,
  };
}

export function toInvoiceDto(row: InvoiceRow): InvoiceDto {
  if (row.customerPartyId === null) throw new Error(`invoice ${row.id} has no customer`);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    number: row.number,
    fiscalYear: row.fiscalYear,
    customerId: row.customerPartyId,
    salesOrderId: row.salesOrderId,
    scheduleLineId: row.scheduleLineId,
    originalInvoiceId: row.originalInvoiceId,
    manualReason: row.manualReason,
    noteReason: row.noteReason,
    currency: row.currency,
    totals: {
      subtotal: row.subtotal,
      discountAmount: row.discountAmount,
      taxableAmount: row.taxableVatAmount,
      exemptAmount: row.exemptAmount,
      zeroRatedAmount: row.zeroRatedAmount,
      taxAmount: row.taxAmount,
      total: row.total,
    },
    npr: nprOf(row),
    issueDate: row.issueDate,
    issueDateBs: row.issueDateBs,
    dueDate: row.dueDate,
    seller: row.sellerSnapshot === null ? null : PartySnapshotSchema.parse(row.sellerSnapshot),
    buyer: row.buyerSnapshot === null ? null : PartySnapshotSchema.parse(row.buyerSnapshot),
    calcVersion: row.calcVersion,
    contentHash: row.contentHash === null ? null : row.contentHash.toString('hex'),
    approvalRequestId: row.approvalRequestId,
    version: row.version,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * The lines with their tax. A line has no tax column: each tax code's summary tax is spread back over its lines by
 * largest remainder on taxable, so the line taxes add up to the summary exactly (the same rule as `lineVat`).
 */
export function toLineDtos(
  lines: readonly InvoiceLineRow[],
  taxSummary: readonly InvoiceTaxSummaryRow[],
): InvoiceLineDto[] {
  const ordered = [...lines].sort((a, b) => a.lineNo - b.lineNo);
  const taxOf = new Map<string, string>();
  for (const summary of taxSummary) {
    const mine = ordered.filter((l) => l.taxCodeId === summary.taxCodeId);
    const shares = allocateLargestRemainder(
      new Dec(summary.tax),
      mine.map((l) => new Dec(l.taxable)),
    );
    mine.forEach((l, i) => taxOf.set(l.id, shares[i]!.toFixed(2)));
  }
  return ordered.map((l) => ({
    lineNo: l.lineNo,
    // invoice_lines has no catalog item column: the link is not kept on an invoice.
    catalogItemId: null,
    description: l.description,
    uom: l.uom,
    quantity: l.quantity,
    unitPrice: l.unitPrice,
    taxCodeId: l.taxCodeId,
    gross: l.gross,
    discountAlloc: l.discountAlloc,
    taxable: l.taxable,
    taxAmount: taxOf.get(l.id) ?? '0.00',
  }));
}

export function toTaxSummaryItems(rows: readonly InvoiceTaxSummaryRow[]): InvoiceTaxSummaryItem[] {
  return rows.map((r) => ({
    taxCodeId: r.taxCodeId,
    label: r.label,
    percent: r.rate,
    base: r.base,
    tax: r.tax,
  }));
}

export interface InvoiceParts {
  invoice: InvoiceRow;
  /** The customer's current legal name; undefined when the customer row is not found. */
  customerName?: string | undefined;
  lines: readonly InvoiceLineRow[];
  taxSummary: readonly InvoiceTaxSummaryRow[];
  prints: readonly InvoicePrintRow[];
}

export function toInvoiceDetail(parts: InvoiceParts): InvoiceDetail {
  return {
    invoice: toInvoiceDto(parts.invoice),
    ...(parts.customerName ? { customerName: parts.customerName } : {}),
    lines: toLineDtos(parts.lines, parts.taxSummary),
    taxSummary: toTaxSummaryItems(parts.taxSummary),
    prints: [...parts.prints]
      .sort((a, b) => a.printNo - b.printNo)
      .flatMap((p) =>
        p.printedBy === null
          ? []
          : [{ printNo: p.printNo, printedBy: p.printedBy, printedAt: p.printedAt.toISOString() }],
      ),
    format: firstPrintFormat(parts.prints),
  };
}

/**
 * The number and date format the original PDF was drawn with: the one stored on print 1, which every copy reuses
 * (the render sweeper's `formatFor`). Read from the raw rows, not the mapped `prints`, which leave out a print with no
 * user. Null when there is no print 1, it predates the stored format, or what is stored does not validate.
 */
export function firstPrintFormat(
  prints: readonly Pick<InvoicePrintRow, 'printNo' | 'renderFormat'>[],
): DocumentFormatSnapshot | null {
  const original = prints.find((p) => p.printNo === 1);
  if (original === undefined || original.renderFormat === null) return null;
  const parsed = DocumentFormatSnapshotSchema.safeParse(original.renderFormat);
  return parsed.success ? parsed.data : null;
}

/**
 * What `principal` may do on one invoice: the record checks the commands make, so a grant narrowed to `own` offers an
 * action only on the invoices the caller drafted. Submit, issue, discard and notes judge the drafter (`createdBy`);
 * a payment is recorded against the customer, as the payment command checks it.
 */
export function invoiceCan(
  principal: Principal,
  scope: TxScope,
  row: Pick<InvoiceRow, 'createdBy' | 'customerPartyId'>,
): InvoiceCan {
  const drafted = { ...scope, ownerUserId: row.createdBy };
  const on = (permission: Permission) => can(principal, permission, drafted).allowed;
  return {
    submit: on('invoice.submit'),
    issue: on('invoice.issue'),
    discard: on('invoice.draft'),
    notes: on('invoice.credit_note'),
    recordPayment:
      row.customerPartyId !== null &&
      can(principal, 'payment.record', {
        ...scope,
        customerPartyId: row.customerPartyId,
        sodUserIds: [],
      }).allowed,
  };
}

/** Why `PATCH /v1/invoices/:id/due-date` refuses: 403 for the caller, 409 for the invoice's kind or status. */
export interface DueDateEditRefusal {
  status: 403 | 409;
  reason: string;
}

const DUE_DATE_STATUS_REASON: Partial<Record<InvoiceRow['status'], string>> = {
  submitted: 'The invoice is waiting for approval; its due date can be changed once it is returned',
  approved: 'Take the invoice back to draft to change its due date',
  issued: 'An issued invoice cannot be changed',
  discarded: 'A discarded invoice cannot be changed',
};

/**
 * The one rule behind the due-date route and its `can.editDueDate` flag, so the page never offers what the route
 * refuses. Who: `invoice.draft` on the drafter, as discard. Which kinds: only those that issue with the drafted due
 * date (`dueDateOf` in the issue service recomputes it for an order's tax invoice and a debit note, so an edit there
 * would be thrown away at issue). When: while the lines are editable (draft, returned). Null when allowed.
 */
export function dueDateEditRefusal(
  principal: Principal,
  scope: TxScope,
  row: Pick<InvoiceRow, 'createdBy' | 'kind' | 'status' | 'salesOrderId'>,
): DueDateEditRefusal | null {
  if (!can(principal, 'invoice.draft', { ...scope, ownerUserId: row.createdBy }).allowed) {
    return {
      status: 403,
      reason: 'Only someone who may draft this invoice can change its due date',
    };
  }
  if (row.kind === 'credit_note') {
    return { status: 409, reason: 'A credit note has no due date of its own' };
  }
  if (row.kind === 'debit_note') {
    return {
      status: 409,
      reason: "A debit note's due date is set when it is issued",
    };
  }
  if (row.kind === 'tax_invoice' && row.salesOrderId !== null) {
    return {
      status: 409,
      reason:
        "This invoice's due date is set when it is issued, from the sales order's credit days",
    };
  }
  if (!isInvoiceEditable(row.status)) {
    return {
      status: 409,
      reason: DUE_DATE_STATUS_REASON[row.status] ?? 'This invoice cannot be changed',
    };
  }
  return null;
}

/** `can.editDueDate` for the detail answer. */
export function editDueDateCan(
  principal: Principal,
  scope: TxScope,
  row: Pick<InvoiceRow, 'createdBy' | 'kind' | 'status' | 'salesOrderId'>,
): NonNullable<InvoiceCan['editDueDate']> {
  const refusal = dueDateEditRefusal(principal, scope, row);
  return refusal === null ? { allowed: true } : { allowed: false, reason: refusal.reason };
}

export function toInvoiceListItem(row: InvoiceRow, customerName: string): InvoiceListItem {
  if (row.customerPartyId === null) throw new Error(`invoice ${row.id} has no customer`);
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    number: row.number,
    customerId: row.customerPartyId,
    customerName,
    currency: row.currency,
    total: row.total,
    issueDate: row.issueDate,
    dueDate: row.dueDate,
  };
}
