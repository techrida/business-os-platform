// Contracts for payables (P4): vendor bills, matching, match exceptions and payment requests.
// Serves the NFR "a bill is paid only once": a bill reaches approval only through matching or an approved
// exception, and a payment request is the approved instruction, not the payout (AD1). Totals are computed
// by the server from the lines, so no body here accepts one. Money is a numeric(18,2) string.
import { z } from 'zod';

import { CurrencySchema, DecimalString } from './money.js';
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

// ---------------------------------------------------------------------------------------------
// Vendor bill (A4 section 2.4)
// ---------------------------------------------------------------------------------------------

export const BILL_STATUSES = [
  'draft',
  'matching',
  'variance',
  'exception_pending',
  'pending_approval',
  'approved',
  'partially_paid',
  'paid',
  'voided',
  'rejected',
  'discarded',
] as const;
export const BillStatusSchema = z.enum(BILL_STATUSES);
export type BillStatus = z.infer<typeof BillStatusSchema>;

// Every move the bills service writes: a non-PO bill is submitted from draft (match not required), a first match
// outside tolerance goes from draft to variance, and a rejected or returned match exception puts the bill back in
// variance. A re-run that leaves the status as it is (matching, variance) is not a move.
export const BILL_TRANSITIONS: Readonly<Record<BillStatus, readonly BillStatus[]>> = {
  draft: ['matching', 'variance', 'pending_approval', 'discarded'],
  matching: ['variance', 'pending_approval'],
  variance: ['matching', 'exception_pending'],
  exception_pending: ['pending_approval', 'variance'],
  pending_approval: ['approved', 'draft', 'rejected'],
  approved: ['partially_paid', 'paid', 'voided'],
  partially_paid: ['paid'],
  paid: [],
  voided: [],
  rejected: [],
  discarded: [],
};
export const canTransitionBill = (from: BillStatus, to: BillStatus) =>
  allowed(BILL_TRANSITIONS, from, to);

export const BILL_KINDS = ['bill', 'vendor_credit_note'] as const;
export const BillKindSchema = z.enum(BILL_KINDS);
export type BillKind = z.infer<typeof BillKindSchema>;

export const MATCH_STATUSES = [
  'not_required',
  'pending',
  'matched',
  'variance',
  'exception_approved',
] as const;
export const MatchStatusSchema = z.enum(MATCH_STATUSES);
export type MatchStatus = z.infer<typeof MatchStatusSchema>;

export const MATCH_EXCEPTION_STATUSES = ['pending', 'approved', 'rejected'] as const;
export const MatchExceptionStatusSchema = z.enum(MATCH_EXCEPTION_STATUSES);
export type MatchExceptionStatus = z.infer<typeof MatchExceptionStatusSchema>;

// ---------------------------------------------------------------------------------------------
// Payment request (AD1: the request and its approval only; the payout is out of scope)
// ---------------------------------------------------------------------------------------------

export const PAYMENT_REQUEST_STATUSES = [
  'draft',
  'pending_approval',
  'approved',
  'rejected',
  'cancelled',
] as const;
export const PaymentRequestStatusSchema = z.enum(PAYMENT_REQUEST_STATUSES);
export type PaymentRequestStatus = z.infer<typeof PaymentRequestStatusSchema>;

export const PAYMENT_REQUEST_TRANSITIONS: Readonly<
  Record<PaymentRequestStatus, readonly PaymentRequestStatus[]>
> = {
  draft: ['pending_approval', 'cancelled'],
  pending_approval: ['approved', 'rejected'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};
export const canTransitionPaymentRequest = (from: PaymentRequestStatus, to: PaymentRequestStatus) =>
  allowed(PAYMENT_REQUEST_TRANSITIONS, from, to);

export const PAYMENT_TYPES = ['settlement', 'advance'] as const;
export const PaymentTypeSchema = z.enum(PAYMENT_TYPES);
export type PaymentType = z.infer<typeof PaymentTypeSchema>;

// ---------------------------------------------------------------------------------------------
// Bodies
// ---------------------------------------------------------------------------------------------

export const VendorBillLineBodySchema = z.strictObject({
  /** Links the line to the order and receipt it is matched against. Both are optional for a non-PO bill. */
  poLineId: z.guid().optional(),
  receiptLineId: z.guid().optional(),
  accountId: z.guid(),
  costCenterId: z.guid().optional(),
  projectId: z.guid().optional(),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  taxCodeId: z.guid(),
  /** Withholding code for TDS (tax deducted at source); the rate comes from the code, not the client. */
  tdsCodeId: z.guid().optional(),
});
export type VendorBillLineBody = z.infer<typeof VendorBillLineBodySchema>;

/**
 * Key in a vendor bill. Strict, so a client cannot send `payableTotal`, `status` or `matchStatus`: the
 * server computes net + VAT - TDS and runs the match.
 */
export const CreateVendorBillBodySchema = z.strictObject({
  vendorPartyId: z.guid(),
  kind: BillKindSchema.default('bill'),
  vendorInvoiceNo: text(64),
  invoiceDate: isoDate,
  currency: CurrencySchema,
  purchaseOrderId: z.guid().optional(),
  /** The vendor's invoice file, scanned clean before the bill can be submitted. */
  documentId: z.guid(),
  /** Set when the bill is keyed from a portal inbox submission. */
  sourceSubmissionId: z.guid().optional(),
  lines: z.array(VendorBillLineBodySchema).min(1).max(200),
});
export type CreateVendorBillBody = z.infer<typeof CreateVendorBillBodySchema>;

/** Ask for a match exception on a bill that is outside tolerance; Finance decides (AD5). */
export const RequestMatchExceptionBodySchema = z.strictObject({
  reason: text(1000),
  evidenceDocumentId: z.guid().optional(),
});
export type RequestMatchExceptionBody = z.infer<typeof RequestMatchExceptionBodySchema>;

export const VoidVendorBillBodySchema = z.strictObject({ reason: text(500) });
export type VoidVendorBillBody = z.infer<typeof VoidVendorBillBodySchema>;

export const PaymentAllocationBodySchema = z.strictObject({
  /** The payable open item of an approved bill. The line may not exceed the derived open amount. */
  openItemId: z.guid(),
  amount: DecimalString.refine((s) => /[1-9]/.test(s) && !s.startsWith('-'), 'must be above zero'),
});
export type PaymentAllocationBody = z.infer<typeof PaymentAllocationBodySchema>;

/**
 * Request a payment. Strict: the verified bank account is snapshotted by the server, never named by the
 * client. An advance must name the purchase order it advances.
 */
export const RequestPaymentBodySchema = z
  .strictObject({
    vendorPartyId: z.guid(),
    paymentType: PaymentTypeSchema,
    purchaseOrderId: z.guid().optional(),
    currency: CurrencySchema,
    /** The paying entity bank account the money leaves from. */
    fromBankAccountId: z.guid(),
    allocations: z.array(PaymentAllocationBodySchema).min(1).max(200),
  })
  .refine((v) => v.paymentType !== 'advance' || v.purchaseOrderId !== undefined, {
    message: 'an advance must name its purchase order',
    path: ['purchaseOrderId'],
  });
export type RequestPaymentBody = z.infer<typeof RequestPaymentBodySchema>;
