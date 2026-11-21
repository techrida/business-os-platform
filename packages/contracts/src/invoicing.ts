// Contracts for invoices, credit notes, debit notes and proformas (P3). Serves the NFR "amounts are
// exact" (money is numeric(18,2) strings) and "a customer sees only what we meant to show"
// (`CustomerInvoiceViewSchema` is a strict whitelist). The number, issue date and content hash are set
// by the server at issue and are read-only here: no body carries them (plan A10, A15).
import { z } from 'zod';

import { DocumentFormatSnapshotSchema } from './document-style.js';
import { CurrencySchema, DecimalString, NprSnapshotSchema } from './money.js';
import { DiscountSchema, NonNegativeDecimalString, QuantityString } from './quotations.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const expectedVersion = z.number().int().min(1);

// ---------------------------------------------------------------------------------------------
// Kinds, statuses and transitions
// ---------------------------------------------------------------------------------------------

export const INVOICE_KINDS = ['tax_invoice', 'proforma', 'credit_note', 'debit_note'] as const;
export const InvoiceKindSchema = z.enum(INVOICE_KINDS);
export type InvoiceKind = z.infer<typeof InvoiceKindSchema>;

export const INVOICE_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'approved',
  'issued',
  'discarded',
] as const;
export const InvoiceStatusSchema = z.enum(INVOICE_STATUSES);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

/** Credit and debit notes are tied to the invoice they correct. */
export const isNoteKind = (k: InvoiceKind): boolean => k === 'credit_note' || k === 'debit_note';

/**
 * Allowed status moves for the approved kinds (tax invoice, credit note, debit note). An edit voids an
 * approval (`approved` back to `draft`); `issued` and `discarded` are terminal. A proforma skips the
 * approval: see `PROFORMA_TRANSITIONS`.
 */
export const INVOICE_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['submitted', 'discarded'],
  submitted: ['returned', 'approved'],
  returned: ['submitted', 'discarded'],
  approved: ['draft', 'issued'],
  issued: [],
  discarded: [],
};

/** A proforma goes draft to issued with no approval and no posting (plan A12). */
export const PROFORMA_TRANSITIONS: Readonly<Record<InvoiceStatus, readonly InvoiceStatus[]>> = {
  draft: ['issued', 'discarded'],
  submitted: [],
  returned: [],
  approved: [],
  issued: [],
  discarded: [],
};

export const canTransitionInvoice = (
  kind: InvoiceKind,
  from: InvoiceStatus,
  to: InvoiceStatus,
): boolean => (kind === 'proforma' ? PROFORMA_TRANSITIONS : INVOICE_TRANSITIONS)[from].includes(to);

/** Lines change only in draft or returned. */
export const isInvoiceEditable = (s: InvoiceStatus): boolean => s === 'draft' || s === 'returned';

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export const InvoiceLineDtoSchema = z.object({
  lineNo: z.number().int().min(1),
  catalogItemId: z.guid().nullable(),
  description: z.string(),
  uom: z.string(),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  taxCodeId: z.guid(),
  gross: DecimalString,
  discountAlloc: DecimalString,
  taxable: DecimalString,
  taxAmount: DecimalString,
});
export type InvoiceLineDto = z.infer<typeof InvoiceLineDtoSchema>;

/** Tax is rounded once per tax code, not per line (the same rule as quotations). */
export const InvoiceTaxSummaryItemSchema = z.object({
  taxCodeId: z.guid(),
  label: z.string(),
  percent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
  base: DecimalString,
  tax: DecimalString,
});
export type InvoiceTaxSummaryItem = z.infer<typeof InvoiceTaxSummaryItemSchema>;

/** Totals by bucket: the VAT base, exempt and zero-rated amounts, VAT and the grand total. */
export const InvoiceTotalsSchema = z.object({
  subtotal: DecimalString,
  discountAmount: DecimalString,
  taxableAmount: DecimalString,
  exemptAmount: DecimalString,
  zeroRatedAmount: DecimalString,
  taxAmount: DecimalString,
  total: DecimalString,
});
export type InvoiceTotals = z.infer<typeof InvoiceTotalsSchema>;

/** The seller or buyer as frozen at issue. */
export const PartySnapshotSchema = z.object({
  legalName: z.string().min(1),
  panVatNo: z.string().nullable(),
  address: z.string().nullable(),
});
export type PartySnapshot = z.infer<typeof PartySnapshotSchema>;

/**
 * The invoice header. There is deliberately no stored payment status: what is owed and what is settled
 * is derived from allocations (plan A8) and read through `InvoiceSettlementSchema` in receivables.
 */
export const InvoiceDtoSchema = z
  .object({
    id: z.guid(),
    kind: InvoiceKindSchema,
    status: InvoiceStatusSchema,
    /** Assigned at issue only: INV-2083/84-00001. */
    number: z.string().min(1).max(40).nullable(),
    fiscalYear: z.string().min(1).nullable(),
    customerId: z.guid(),
    salesOrderId: z.guid().nullable(),
    scheduleLineId: z.guid().nullable(),
    /** The invoice a credit or debit note corrects. */
    originalInvoiceId: z.guid().nullable(),
    manualReason: z.string().nullable(),
    noteReason: z.string().nullable(),
    currency: CurrencySchema,
    totals: InvoiceTotalsSchema,
    /** Frozen at issue; null while the document is still a draft. */
    npr: NprSnapshotSchema.nullable(),
    /** Server "today" in Asia/Kathmandu, set at issue and never back-dated (plan A10). */
    issueDate: isoDate.nullable(),
    issueDateBs: z.string().min(1).nullable(),
    dueDate: isoDate.nullable(),
    seller: PartySnapshotSchema.nullable(),
    buyer: PartySnapshotSchema.nullable(),
    calcVersion: z.number().int().min(1),
    contentHash: sha256Hex.nullable(),
    approvalRequestId: z.guid().nullable(),
    version: expectedVersion,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((i, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if ((i.status === 'issued') !== (i.number !== null)) {
      fail('number', 'a number exists exactly when the invoice is issued');
    }
    if (i.status === 'issued') {
      if (i.issueDate === null || i.issueDateBs === null)
        fail('issueDate', 'issued needs an issue date');
      if (i.contentHash === null) fail('contentHash', 'issued needs a content hash');
      if (i.npr === null || i.buyer === null || i.seller === null) {
        fail('npr', 'issued needs the NPR value and the seller and buyer snapshots');
      }
    }
    if (isNoteKind(i.kind) !== (i.originalInvoiceId !== null)) {
      fail(
        'originalInvoiceId',
        'a credit or debit note names its original invoice, and nothing else does',
      );
    }
    if (isNoteKind(i.kind) && i.noteReason === null) fail('noteReason', 'a note needs a reason');
    if (i.kind === 'tax_invoice' && i.salesOrderId === null && i.manualReason === null) {
      fail('manualReason', 'a tax invoice without a sales order needs a manual reason');
    }
    if (i.kind === 'proforma' && ['submitted', 'returned', 'approved'].includes(i.status)) {
      fail('status', 'a proforma has no approval states');
    }
  });
export type InvoiceDto = z.infer<typeof InvoiceDtoSchema>;

/**
 * The derived state of one invoice, from its allocations, credit notes and due date. These are values
 * of a computed status, not stored columns. `settlementOf` in money-rules produces them.
 */
export const SETTLEMENT_STATUSES = [
  'unpaid',
  'partly_paid',
  'paid',
  'overdue',
  'credited',
] as const;
export const SettlementStatusSchema = z.enum(SETTLEMENT_STATUSES);
export type SettlementStatus = z.infer<typeof SettlementStatusSchema>;

/**
 * What the caller may do on one invoice, from its live grants judged on that record (the drafter owns it for `own`),
 * the same record checks the commands make. Whether the status allows the move is the transition table's answer, not
 * this one. Optional so an older API answer still parses.
 */
export const InvoiceCanSchema = z.object({
  /** `invoice.submit`: send for approval, or resubmit a returned invoice. */
  submit: z.boolean(),
  /** `invoice.issue`. */
  issue: z.boolean(),
  /** `invoice.draft`: discard a draft. */
  discard: z.boolean(),
  /** `invoice.credit_note`: credit and debit notes alike. */
  notes: z.boolean(),
  /** `payment.record` for the invoice's customer; false when the invoice names none. */
  recordPayment: z.boolean(),
  /**
   * Whether `PATCH /v1/invoices/:id/due-date` would accept this caller on this invoice now, by the same rule the route
   * applies (permission, kind and status, unlike the flags above). `reason` says why not, in words the page can show.
   * Only `GET /v1/invoices/:id` sets it; optional so an older API answer still parses.
   */
  editDueDate: z.object({ allowed: z.boolean(), reason: z.string().optional() }).optional(),
});
export type InvoiceCan = z.infer<typeof InvoiceCanSchema>;

/** One row of `GET /v1/invoices`. */
export const InvoiceListItemSchema = z.object({
  id: z.guid(),
  kind: InvoiceKindSchema,
  status: InvoiceStatusSchema,
  number: z.string().nullable(),
  customerId: z.guid(),
  customerName: z.string().min(1),
  currency: CurrencySchema,
  total: DecimalString,
  issueDate: isoDate.nullable(),
  dueDate: isoDate.nullable(),
  /**
   * Paid, overdue and the rest, derived from the open item (never stored), for an issued tax invoice or debit
   * note; null for anything without an open item (drafts, proformas, credit notes). Optional so an older API
   * answer still parses.
   */
  settlement: SettlementStatusSchema.nullable().optional(),
  /** What is still owed, in the invoice's currency; null exactly when `settlement` is. */
  openAmount: DecimalString.nullable().optional(),
  can: InvoiceCanSchema.optional(),
});
export type InvoiceListItem = z.infer<typeof InvoiceListItemSchema>;

export const InvoicePrintDtoSchema = z.object({
  printNo: z.number().int().min(1),
  printedBy: z.guid(),
  printedAt: isoDateTime,
});
export type InvoicePrintDto = z.infer<typeof InvoicePrintDtoSchema>;

export const InvoiceDetailSchema = z.object({
  invoice: InvoiceDtoSchema,
  /**
   * The customer's current legal name, read with the invoice in its tenant, so a draft (no `buyer` snapshot yet)
   * can name its customer without a customer read. `invoice.buyer` stays the name frozen at issue. Optional so an
   * older API answer still parses.
   */
  customerName: z.string().min(1).optional(),
  lines: z.array(InvoiceLineDtoSchema),
  taxSummary: z.array(InvoiceTaxSummaryItemSchema),
  prints: z.array(InvoicePrintDtoSchema),
  /**
   * The number grouping and date pattern the original PDF (print 1) was drawn with; every copy reuses it. Null when
   * the invoice was never printed or its first print predates the stored format. Optional so an older API answer
   * still parses.
   */
  format: DocumentFormatSnapshotSchema.nullable().optional(),
  /**
   * True when the caller created this credit or debit note, so may not issue it (TR-Q12f, separation of duties): the
   * workspace shows Issue disabled with the reason. Only `GET /v1/invoices/:id` sets it, and only when true; optional
   * so an older API answer still parses.
   */
  issueBlockedBySod: z.boolean().optional(),
  /**
   * The derived settlement, as on a list row: set by `GET /v1/invoices/:id` for an issued tax invoice or debit note,
   * null for anything without an open item. The command answers leave it out; optional so an older API answer still
   * parses.
   */
  settlement: SettlementStatusSchema.nullable().optional(),
  /** What is still owed, in the invoice's currency; null exactly when `settlement` is. */
  openAmount: DecimalString.nullable().optional(),
  /** Set by `GET /v1/invoices/:id`; the command answers leave it out. */
  can: InvoiceCanSchema.optional(),
});
export type InvoiceDetail = z.infer<typeof InvoiceDetailSchema>;

// ---------------------------------------------------------------------------------------------
// Bodies (an `Idempotency-Key` header goes with every command; it is not a body field)
// ---------------------------------------------------------------------------------------------

/** A line the author types on a manual invoice or a debit note. The server prices it. */
export const InvoiceLineInputSchema = z.strictObject({
  catalogItemId: z.guid().optional(),
  description: text(500),
  uom: text(20),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  taxCodeId: z.guid(),
});
export type InvoiceLineInput = z.infer<typeof InvoiceLineInputSchema>;

/** Draft the next invoice from a billable schedule line. A line already drafted answers `SCHEDULE_LINE_TAKEN`. */
export const DraftFromScheduleBodySchema = z.strictObject({ scheduleLineId: z.guid() });
export type DraftFromScheduleBody = z.infer<typeof DraftFromScheduleBodySchema>;

/** A tax invoice with no sales order (plan A11): the reason is required. */
export const CreateManualInvoiceBodySchema = z.strictObject({
  customerId: z.guid(),
  currency: CurrencySchema,
  manualReason: text(1000),
  dueDate: isoDate.optional(),
  /** One document discount, the same shape a quotation carries. */
  discount: DiscountSchema.optional(),
  lines: z.array(InvoiceLineInputSchema).min(1).max(200),
});
export type CreateManualInvoiceBody = z.infer<typeof CreateManualInvoiceBodySchema>;

export const CreateProformaBodySchema = z.strictObject({
  customerId: z.guid(),
  currency: CurrencySchema,
  salesOrderId: z.guid().optional(),
  dueDate: isoDate.optional(),
  lines: z.array(InvoiceLineInputSchema).min(1).max(200),
});
export type CreateProformaBody = z.infer<typeof CreateProformaBodySchema>;

/** Edit a draft or returned invoice. Dates, number and totals are not editable: the server computes them. */
export const UpdateInvoiceDraftBodySchema = z.strictObject({
  expectedVersion,
  dueDate: isoDate.nullable().optional(),
  manualReason: text(1000).optional(),
  lines: z.array(InvoiceLineInputSchema).min(1).max(200).optional(),
});
export type UpdateInvoiceDraftBody = z.infer<typeof UpdateInvoiceDraftBodySchema>;

export const SubmitInvoiceBodySchema = z.strictObject({ expectedVersion });
export type SubmitInvoiceBody = z.infer<typeof SubmitInvoiceBodySchema>;

export const DiscardInvoiceBodySchema = z.strictObject({ expectedVersion, reason: text(1000) });
export type DiscardInvoiceBody = z.infer<typeof DiscardInvoiceBodySchema>;

/**
 * `PATCH /v1/invoices/:id/due-date`: a new due date on a draft or returned invoice whose drafted due date is the one it
 * issues with (a manual tax invoice or a proforma). A date before today answers 422 DUE_DATE_BEFORE_ISSUE, as issue does.
 */
export const EditInvoiceDueDateBodySchema = z.strictObject({ expectedVersion, dueDate: isoDate });
export type EditInvoiceDueDateBody = z.infer<typeof EditInvoiceDueDateBodySchema>;

/**
 * `POST /v1/invoices/:id/reopen`: an approved invoice back to draft (its due date passed before issue, say). The
 * approval no longer counts. While it is a draft, a manual tax invoice's due date can be changed (`PATCH
 * /v1/invoices/:id/due-date`); then it must be submitted for approval again. The reason stays in its history.
 */
export const ReopenInvoiceBodySchema = z.strictObject({ expectedVersion, reason: text(1000) });
export type ReopenInvoiceBody = z.infer<typeof ReopenInvoiceBodySchema>;

export const IssueInvoiceBodySchema = z.strictObject({ expectedVersion });
export type IssueInvoiceBody = z.infer<typeof IssueInvoiceBodySchema>;

/** `issued` is the first call; `already_issued` answers a replay or a double click with the same number. */
export const IssueInvoiceResultSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('issued'), invoiceId: z.guid(), number: z.string().min(1) }),
  z.strictObject({
    kind: z.literal('already_issued'),
    invoiceId: z.guid(),
    number: z.string().min(1),
  }),
]);
export type IssueInvoiceResult = z.infer<typeof IssueInvoiceResultSchema>;

/** A credit note names the original lines it credits and how much of each; the server prices the note. */
export const CreditNoteBodySchema = z.strictObject({
  originalInvoiceId: z.guid(),
  reason: text(1000),
  lines: z
    .array(z.strictObject({ originalLineNo: z.number().int().min(1), quantity: QuantityString }))
    .min(1)
    .max(200)
    .refine(
      (l) => new Set(l.map((x) => x.originalLineNo)).size === l.length,
      'each original line appears once',
    ),
});
export type CreditNoteBody = z.infer<typeof CreditNoteBodySchema>;

export const DebitNoteBodySchema = z.strictObject({
  originalInvoiceId: z.guid(),
  reason: text(1000),
  lines: z.array(InvoiceLineInputSchema).min(1).max(200),
});
export type DebitNoteBody = z.infer<typeof DebitNoteBodySchema>;

// ---------------------------------------------------------------------------------------------
// Customer portal view (portal.invoice.read): issued documents only, a whitelist
// ---------------------------------------------------------------------------------------------

/**
 * What the customer sees of one issued invoice. Strict on purpose: an extra key, such as a whole
 * internal invoice, fails to parse instead of leaking. It has no NPR value, FX rate, approval or editor
 * data. A mapper builds it field by field; nothing is spread into it. The amount still open comes from
 * allocations, so it is read through the settlement view, not stored on the invoice.
 */
export const CustomerInvoiceViewSchema = z.strictObject({
  id: z.guid(),
  kind: z.enum(['tax_invoice', 'credit_note', 'debit_note']),
  number: z.string().min(1).max(40),
  issueDate: isoDate,
  issueDateBs: z.string().min(1),
  dueDate: isoDate.nullable(),
  currency: CurrencySchema,
  seller: PartySnapshotSchema,
  buyer: PartySnapshotSchema,
  lines: z.array(
    z.strictObject({
      lineNo: z.number().int().min(1),
      description: z.string(),
      uom: z.string(),
      quantity: QuantityString,
      unitPrice: DecimalString,
      amount: DecimalString,
    }),
  ),
  totals: z.strictObject({
    subtotal: DecimalString,
    discountAmount: DecimalString,
    taxableAmount: DecimalString,
    /** Printed on the PDF when not zero. Optional so an older API answer still parses; the API always sends them. */
    exemptAmount: DecimalString.optional(),
    zeroRatedAmount: DecimalString.optional(),
    taxAmount: DecimalString,
    total: DecimalString,
  }),
  /** `percent` is the VAT percentage, for example "13". */
  taxSummary: z.array(
    z.strictObject({
      label: z.string(),
      percent: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
      base: DecimalString,
      tax: DecimalString,
    }),
  ),
  /** The frozen PDF, null until it is rendered and scanned clean. */
  file: z
    .strictObject({ documentId: z.guid(), filename: z.string(), sha256: sha256Hex })
    .nullable(),
  /**
   * True when the PDF could not be prepared (its render was given up, or the virus scan refused the file); our team
   * has been told. With `file` null and this false, the PDF is still being prepared. Optional for older answers; the
   * API always sends it.
   */
  renderFailed: z.boolean().optional(),
  /**
   * The number grouping and date pattern the original PDF was drawn with (print 1). Null when it was never printed
   * or printed before the format was stored: then draw with `GET /v1/portal/display`. Optional for older answers.
   */
  format: DocumentFormatSnapshotSchema.nullable().optional(),
  /**
   * How to reach the selling company: the saved company profile as it is NOW (not frozen at issue, unlike `seller`).
   * Only these four keys; the address and PAN/VAT number come from the frozen `seller`. Null when the profile cannot
   * be read. Optional for older answers.
   */
  sellerContact: z
    .strictObject({
      phones: z.array(z.string()),
      email: z.string().nullable(),
      signatoryName: z.string().nullable(),
      signatoryTitle: z.string().nullable(),
    })
    .nullable()
    .optional(),
});
export type CustomerInvoiceView = z.infer<typeof CustomerInvoiceViewSchema>;

export const PortalInvoiceListItemSchema = z.strictObject({
  id: z.guid(),
  kind: z.enum(['tax_invoice', 'credit_note', 'debit_note']),
  number: z.string().min(1).max(40),
  issueDate: isoDate,
  dueDate: isoDate.nullable(),
  currency: CurrencySchema,
  total: DecimalString,
  /** What is still owed, derived from allocations. */
  openAmount: DecimalString,
});
export type PortalInvoiceListItem = z.infer<typeof PortalInvoiceListItemSchema>;

// ---------------------------------------------------------------------------------------------
// Sales VAT register (round 5, K1)
// ---------------------------------------------------------------------------------------------

/** Query of `GET /v1/invoices/vat-register`: an inclusive period of issue dates (AD, YYYY-MM-DD). */
export const SalesVatRegisterQuerySchema = z
  .strictObject({ from: isoDate, to: isoDate })
  .refine((v) => v.from <= v.to, {
    message: 'The end date must be on or after the start date.',
    path: ['to'],
  });
export type SalesVatRegisterQuery = z.infer<typeof SalesVatRegisterQuerySchema>;

/** The kinds the sales book lists: proformas and drafts are not tax documents. */
export const SALES_VAT_REGISTER_KINDS = ['tax_invoice', 'credit_note', 'debit_note'] as const;

/**
 * One issued sales document. Amounts are in the document's own currency, two decimals, and signed for the book: a credit
 * note is negative, a debit note and a tax invoice positive. `taxableAmount` is the VAT-able base after discount.
 */
export const SalesVatRegisterRowSchema = z.strictObject({
  invoiceId: z.guid(),
  kind: z.enum(SALES_VAT_REGISTER_KINDS),
  number: z.string().min(1),
  issueDate: isoDate,
  issueDateBs: z.string().min(1),
  buyerName: z.string(),
  buyerPan: z.string().nullable(),
  currency: CurrencySchema,
  taxableAmount: DecimalString,
  vatAmount: DecimalString,
  exemptAmount: DecimalString,
  zeroRatedAmount: DecimalString,
  totalAmount: DecimalString,
});
export type SalesVatRegisterRow = z.infer<typeof SalesVatRegisterRowSchema>;

/** The totals of one currency. Never summed across currencies. */
export const SalesVatRegisterTotalSchema = z.strictObject({
  currency: CurrencySchema,
  documents: z.number().int().min(0),
  taxableAmount: DecimalString,
  vatAmount: DecimalString,
  exemptAmount: DecimalString,
  zeroRatedAmount: DecimalString,
  totalAmount: DecimalString,
});
export type SalesVatRegisterTotal = z.infer<typeof SalesVatRegisterTotalSchema>;

export const SalesVatRegisterSchema = z.strictObject({
  from: isoDate,
  to: isoDate,
  rows: z.array(SalesVatRegisterRowSchema),
  totals: z.array(SalesVatRegisterTotalSchema),
});
export type SalesVatRegister = z.infer<typeof SalesVatRegisterSchema>;
