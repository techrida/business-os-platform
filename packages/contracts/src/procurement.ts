// Contracts for procurement (P4): purchase requests, RFQs and quotations, purchase orders and receipts.
// Serves the NFR "money moves only after the right people agree": a purchase request is approved by the
// department head only, and the commitment route runs on the recommended quote after sourcing (AD10).
// Quantities are numeric(18,4) strings and money is numeric(18,2) strings, never JS numbers.
import { z } from 'zod';

import { CurrencySchema } from './money.js';
import { NonNegativeDecimalString, QuantityString } from './quotations.js';

const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);

function allowed<S extends string>(
  map: Readonly<Record<S, readonly S[]>>,
  from: S,
  to: S,
): boolean {
  return map[from].includes(to);
}

/**
 * The `documentType` of every P4 approval workflow. Business status lives on the document; the
 * approval engine owns workflow state, keyed by one of these.
 */
export const P4_DOCUMENT_TYPES = [
  'purchase_request',
  'pr_commitment',
  'po_amendment',
  'match_exception',
  'vendor_bill',
  'payment_request',
] as const;
export const P4DocumentTypeSchema = z.enum(P4_DOCUMENT_TYPES);
export type P4DocumentType = z.infer<typeof P4DocumentTypeSchema>;

// ---------------------------------------------------------------------------------------------
// Purchase request (A4 section 2.4)
// ---------------------------------------------------------------------------------------------

export const PR_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'dept_approved',
  'sourcing',
  'commitment_pending',
  'approved',
  'po_issued',
  'closed',
  'rejected',
  'cancelled',
] as const;
export const PrStatusSchema = z.enum(PR_STATUSES);
export type PrStatus = z.infer<typeof PrStatusSchema>;

export const PR_TRANSITIONS: Readonly<Record<PrStatus, readonly PrStatus[]>> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['dept_approved', 'returned', 'rejected'],
  returned: ['submitted'],
  dept_approved: ['sourcing'],
  sourcing: ['commitment_pending'],
  commitment_pending: ['approved', 'sourcing', 'rejected'],
  approved: ['po_issued'],
  po_issued: ['closed'],
  closed: [],
  rejected: [],
  cancelled: [],
};
export const canTransitionPr = (from: PrStatus, to: PrStatus) => allowed(PR_TRANSITIONS, from, to);

export const PR_REQUEST_TYPES = ['goods', 'service', 'mixed'] as const;
export const PrRequestTypeSchema = z.enum(PR_REQUEST_TYPES);
export type PrRequestType = z.infer<typeof PrRequestTypeSchema>;

// ---------------------------------------------------------------------------------------------
// RFQ, quotations and the portal inbox
// ---------------------------------------------------------------------------------------------

export const RFQ_STATUSES = ['open', 'closed', 'recommended', 'cancelled'] as const;
export const RfqStatusSchema = z.enum(RFQ_STATUSES);
export type RfqStatus = z.infer<typeof RfqStatusSchema>;

export const RFQ_TRANSITIONS: Readonly<Record<RfqStatus, readonly RfqStatus[]>> = {
  open: ['closed', 'cancelled'],
  closed: ['recommended', 'cancelled'],
  // A commitment returned to re-source reopens the RFQ (A4 2.4).
  recommended: ['open', 'cancelled'],
  cancelled: [],
};
export const canTransitionRfq = (from: RfqStatus, to: RfqStatus) =>
  allowed(RFQ_TRANSITIONS, from, to);

/** A vendor's uploaded quotation or bill waiting in the inbox. Staff convert it; it never posts anything. */
export const INBOX_SUBMISSION_STATUSES = [
  'received',
  'converted',
  'rejected',
  'withdrawn',
] as const;
export const InboxSubmissionStatusSchema = z.enum(INBOX_SUBMISSION_STATUSES);
export type InboxSubmissionStatus = z.infer<typeof InboxSubmissionStatusSchema>;

export const INBOX_SUBMISSION_TRANSITIONS: Readonly<
  Record<InboxSubmissionStatus, readonly InboxSubmissionStatus[]>
> = {
  received: ['converted', 'rejected', 'withdrawn'],
  converted: [],
  rejected: [],
  withdrawn: [],
};
export const canTransitionInboxSubmission = (
  from: InboxSubmissionStatus,
  to: InboxSubmissionStatus,
) => allowed(INBOX_SUBMISSION_TRANSITIONS, from, to);

// ---------------------------------------------------------------------------------------------
// Purchase order (A4 section 2.4)
// ---------------------------------------------------------------------------------------------

export const PO_STATUSES = [
  'draft',
  'issued',
  'partially_received',
  'fully_received',
  'amendment_pending',
  'closed',
  'short_closed',
  'cancelled',
] as const;
export const PoStatusSchema = z.enum(PO_STATUSES);
export type PoStatus = z.infer<typeof PoStatusSchema>;

export const PO_TRANSITIONS: Readonly<Record<PoStatus, readonly PoStatus[]>> = {
  draft: ['issued'],
  issued: ['partially_received', 'fully_received', 'amendment_pending', 'cancelled'],
  // The two moves back are receipt reversals: the status follows the quantities received.
  partially_received: ['fully_received', 'issued', 'amendment_pending', 'short_closed'],
  fully_received: ['partially_received', 'issued', 'closed'],
  amendment_pending: ['issued'],
  closed: [],
  short_closed: [],
  cancelled: [],
};
export const canTransitionPo = (from: PoStatus, to: PoStatus) => allowed(PO_TRANSITIONS, from, to);

/** The approval band a PO was committed in (AD4). An amendment needs re-approval only if the band rises. */
export const PO_APPROVED_BANDS = ['base', 'management', 'founder'] as const;
export const PoApprovedBandSchema = z.enum(PO_APPROVED_BANDS);
export type PoApprovedBand = z.infer<typeof PoApprovedBandSchema>;

// ---------------------------------------------------------------------------------------------
// Receipt: draft -> confirmed -> reversed. A reversal is a new negative receipt, never an edit.
// ---------------------------------------------------------------------------------------------

export const RECEIPT_STATUSES = ['draft', 'confirmed', 'reversed'] as const;
export const ReceiptStatusSchema = z.enum(RECEIPT_STATUSES);
export type ReceiptStatus = z.infer<typeof ReceiptStatusSchema>;

export const RECEIPT_TRANSITIONS: Readonly<Record<ReceiptStatus, readonly ReceiptStatus[]>> = {
  draft: ['confirmed'],
  confirmed: ['reversed'],
  reversed: [],
};
export const canTransitionReceipt = (from: ReceiptStatus, to: ReceiptStatus) =>
  allowed(RECEIPT_TRANSITIONS, from, to);

export const RECEIPT_KINDS = ['goods', 'service'] as const;
export const ReceiptKindSchema = z.enum(RECEIPT_KINDS);
export type ReceiptKind = z.infer<typeof ReceiptKindSchema>;

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

export const PurchaseRequestLineBodySchema = z.strictObject({
  description: text(500),
  specification: text(2000).optional(),
  uom: text(20),
  quantity: QuantityString,
  estimatedUnitPrice: NonNegativeDecimalString,
});
export type PurchaseRequestLineBody = z.infer<typeof PurchaseRequestLineBodySchema>;

/**
 * Create or replace a draft purchase request. Strict: `status`, `number` and the totals are the
 * server's. An emergency request must say why (A4 2.3), because it adds a Management step (AD12).
 */
export const CreatePurchaseRequestBodySchema = z
  .strictObject({
    requestType: PrRequestTypeSchema,
    departmentId: z.guid(),
    costCenterId: z.guid(),
    justification: text(2000),
    requiredBy: isoDate,
    deliveryLocation: text(200).optional(),
    budgetCode: text(64),
    projectId: z.guid().optional(),
    currency: CurrencySchema,
    isEmergency: z.boolean().default(false),
    emergencyReason: text(1000).optional(),
    lines: z.array(PurchaseRequestLineBodySchema).min(1).max(200),
  })
  .refine((v) => !v.isEmergency || v.emergencyReason !== undefined, {
    message: 'an emergency request needs a reason',
    path: ['emergencyReason'],
  });
export type CreatePurchaseRequestBody = z.infer<typeof CreatePurchaseRequestBodySchema>;

/**
 * Recommend one quotation. With fewer quotes than `procurement.min_quotes`, the service refuses unless
 * `fewerThanThreeReason` is present (AD13); the count lives in settings, so this schema cannot check it.
 */
export const RecommendQuotationBodySchema = z.strictObject({
  vendorQuotationId: z.guid(),
  rationale: text(2000),
  fewerThanThreeReason: text(1000).optional(),
});
export type RecommendQuotationBody = z.infer<typeof RecommendQuotationBodySchema>;

export const ReceiptLineBodySchema = z.strictObject({
  poLineId: z.guid(),
  /** Above zero. A return is a reversal of a confirmed receipt, not a negative line typed by hand. */
  quantity: QuantityString,
  /**
   * The approved over-receipt exception that allows this line to exceed what is open. There is no exceptions table
   * yet, so the receipts service accepts only null or absent and answers 422 for an id.
   */
  overReceiptExceptionId: z.guid().nullable().optional(),
  inspection: text(500).optional(),
  discrepancyNote: text(1000).optional(),
  serials: z
    .array(
      z.strictObject({
        serialNo: text(100),
        batchNo: text(100).optional(),
        warrantyUntil: isoDate.optional(),
      }),
    )
    .max(1000)
    .optional(),
});

/** Confirm a goods receipt or service confirmation against one purchase order. */
export const ConfirmReceiptBodySchema = z.strictObject({
  purchaseOrderId: z.guid(),
  kind: ReceiptKindSchema,
  receivedAt: isoDate,
  location: text(200).optional(),
  lines: z.array(ReceiptLineBodySchema).min(1).max(200),
});
export type ConfirmReceiptBody = z.infer<typeof ConfirmReceiptBodySchema>;

export const ReverseReceiptBodySchema = z.strictObject({ reason: text(500) });
export type ReverseReceiptBody = z.infer<typeof ReverseReceiptBodySchema>;

/** Amend an issued PO: a new version. Changing the vendor is a cancel and a new PO, so no vendor field here. */
export const AmendPurchaseOrderBodySchema = z.strictObject({
  reason: text(1000),
  paymentTermsDays: z.number().int().min(0).max(365).optional(),
  lines: z
    .array(
      z.strictObject({
        poLineId: z.guid(),
        quantity: QuantityString.optional(),
        unitPrice: NonNegativeDecimalString.optional(),
      }),
    )
    .min(1)
    .max(200),
});
export type AmendPurchaseOrderBody = z.infer<typeof AmendPurchaseOrderBodySchema>;

export const ShortClosePurchaseOrderBodySchema = z.strictObject({ reason: text(500) });
export type ShortClosePurchaseOrderBody = z.infer<typeof ShortClosePurchaseOrderBodySchema>;
