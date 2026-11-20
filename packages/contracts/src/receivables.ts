// Contracts for customer payments, allocations and receivables aging (P3). Serves the NFR "amounts are
// exact" (money is numeric(18,2) strings) and plan A8: what is paid is derived from allocations and is
// never stored, so no DTO here has a `paid` or `amount_paid` field. Settlement is a derived status
// (`SETTLEMENT_STATUSES`) and the open amount is computed from allocations on every read.
import { z } from 'zod';

import { InvoiceKindSchema } from './invoicing.js';
import { CurrencySchema, DecimalString, NprSnapshotSchema } from './money.js';
import { NonNegativeDecimalString } from './quotations.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();
const text = (max: number) => z.string().trim().min(1).max(max);
const expectedVersion = z.number().int().min(1);

/** An amount above zero with at most 2 decimals. */
export const PositiveDecimalString = DecimalString.refine(
  (s) => !s.startsWith('-') && /[1-9]/.test(s),
  'must be above zero',
);
export type PositiveDecimalString = z.infer<typeof PositiveDecimalString>;

// ---------------------------------------------------------------------------------------------
// Statuses and vocabularies
// ---------------------------------------------------------------------------------------------

export const PAYMENT_STATUSES = [
  'submitted',
  'verified',
  'rejected',
  'withdrawn',
  'reversed',
] as const;
export const PaymentStatusSchema = z.enum(PAYMENT_STATUSES);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

/** Allowed moves: Finance verifies or rejects, the customer may withdraw, a verified payment may bounce. */
export const PAYMENT_TRANSITIONS: Readonly<Record<PaymentStatus, readonly PaymentStatus[]>> = {
  submitted: ['verified', 'rejected', 'withdrawn'],
  verified: ['reversed'],
  rejected: [],
  withdrawn: [],
  reversed: [],
};

export const PAYMENT_METHODS = ['bank_transfer', 'qr', 'wire', 'cheque', 'cash'] as const;
export const PaymentMethodSchema = z.enum(PAYMENT_METHODS);
export type PaymentMethod = z.infer<typeof PaymentMethodSchema>;

export const PAYMENT_CHANNELS = ['portal', 'staff'] as const;
export const PaymentChannelSchema = z.enum(PAYMENT_CHANNELS);
export type PaymentChannel = z.infer<typeof PaymentChannelSchema>;

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

/** Aging buckets by days past due, counted from Kathmandu "today". `current` is not yet due. */
export const AGING_BUCKETS = ['current', 'd1_30', 'd31_60', 'd61_90', 'd91_plus'] as const;
export const AgingBucketSchema = z.enum(AGING_BUCKETS);
export type AgingBucket = z.infer<typeof AgingBucketSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs
// ---------------------------------------------------------------------------------------------

export const PaymentCapabilitiesSchema = z.object({
  verify: z.boolean(),
  reject: z.boolean(),
  reverse: z.boolean(),
  verifyBlockedBySod: z.boolean().optional(),
});
export type PaymentCapabilities = z.infer<typeof PaymentCapabilitiesSchema>;

export const PaymentDtoSchema = z
  .object({
    id: z.guid(),
    customerId: z.guid(),
    status: PaymentStatusSchema,
    method: PaymentMethodSchema,
    /** Plan A13: must equal the currency of every invoice it is allocated to. */
    currency: CurrencySchema,
    /** The cash actually received. */
    amount: PositiveDecimalString,
    /** Tax the customer withheld at source (TDS); it settles the invoice but is not cash. */
    tdsWithheld: NonNegativeDecimalString,
    withholdingCode: z.string().min(1).nullable(),
    /** `amount + tdsWithheld`: what this payment can settle. */
    settles: PositiveDecimalString,
    receivedOn: isoDate,
    bankReference: z.string().nullable(),
    /** Frozen when Finance verifies the payment; null before. */
    npr: NprSnapshotSchema.nullable(),
    submittedBy: z.guid(),
    submittedVia: PaymentChannelSchema,
    verifiedBy: z.guid().nullable(),
    verifiedAt: isoDateTime.nullable(),
    rejectionReason: z.string().nullable(),
    /** Receipt number RCPT-2083/84-00001, set when verified. */
    number: z.string().min(1).max(40).nullable(),
    fiscalYear: z.string().min(1).nullable(),
    proofDocumentIds: z.array(z.guid()),
    /** The credit not yet allocated to an invoice (the customer's advance), derived from allocations. */
    unallocatedAmount: NonNegativeDecimalString,
    can: PaymentCapabilitiesSchema.optional(),
    version: expectedVersion,
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .superRefine((p, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: 'custom', path: [path], message });
    if (p.status === 'rejected' && !p.rejectionReason) {
      fail('rejectionReason', 'a rejection needs a reason');
    }
    if ((p.status === 'verified' || p.status === 'reversed') !== (p.number !== null)) {
      fail('number', 'a receipt number exists exactly when the payment is verified or reversed');
    }
    if (p.verifiedBy !== null && p.verifiedBy === p.submittedBy) {
      fail('verifiedBy', 'the verifier must differ from the submitter');
    }
  });
export type PaymentDto = z.infer<typeof PaymentDtoSchema>;

export const PaymentListItemSchema = z.object({
  id: z.guid(),
  customerId: z.guid(),
  customerName: z.string().min(1),
  status: PaymentStatusSchema,
  number: z.string().nullable(),
  method: PaymentMethodSchema,
  currency: CurrencySchema,
  amount: DecimalString,
  receivedOn: isoDate,
  unallocatedAmount: NonNegativeDecimalString,
});
export type PaymentListItem = z.infer<typeof PaymentListItemSchema>;

/**
 * One of the customer's own payments as the portal shows it (`GET /v1/portal/payments`; plan U13). A strict whitelist
 * of eight fields: the staff DTOs carry the submitter, verifier, NPR value, withholding, rejection reason and version,
 * and none of them may reach a customer. `number` is the receipt number, set once Finance has verified the payment.
 */
export const PortalPaymentListItemSchema = z.strictObject({
  id: z.guid(),
  status: PaymentStatusSchema,
  number: z.string().min(1).nullable(),
  method: PaymentMethodSchema,
  currency: CurrencySchema,
  amount: DecimalString,
  receivedOn: isoDate,
  bankReference: z.string().nullable(),
});
export type PortalPaymentListItem = z.infer<typeof PortalPaymentListItemSchema>;

/**
 * One allocation row. Rows are append-only: a reversal is a new row with a negative amount that points
 * at the original. Exactly one of `paymentId` and `creditNoteId` is set.
 */
export const AllocationDtoSchema = z
  .object({
    id: z.guid(),
    invoiceId: z.guid(),
    paymentId: z.guid().nullable(),
    creditNoteId: z.guid().nullable(),
    amount: DecimalString.refine((s) => Number(s) !== 0, 'must not be zero'),
    reversesAllocationId: z.guid().nullable(),
    reason: z.string().nullable(),
    createdBy: z.guid(),
    createdAt: isoDateTime,
  })
  .superRefine((a, ctx) => {
    if ((a.paymentId === null) === (a.creditNoteId === null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentId'],
        message: 'exactly one of paymentId and creditNoteId is set',
      });
    }
    if (a.amount.startsWith('-') !== (a.reversesAllocationId !== null)) {
      ctx.addIssue({
        code: 'custom',
        path: ['amount'],
        message: 'a negative amount exists exactly on a reversal',
      });
    }
  });
export type AllocationDto = z.infer<typeof AllocationDtoSchema>;

/**
 * An invoice's money position, derived on read from allocations and credit notes. `allocatedAmount` is
 * the net of live allocations; `openAmount` is the total less that net and any credit applied.
 */
export const InvoiceSettlementSchema = z.object({
  invoiceId: z.guid(),
  number: z.string().min(1),
  kind: InvoiceKindSchema,
  customerId: z.guid(),
  currency: CurrencySchema,
  /** The server's issue date; an invoice has a settlement only once it is issued. */
  issueDate: isoDate,
  total: DecimalString,
  allocatedAmount: DecimalString,
  openAmount: DecimalString,
  dueDate: isoDate.nullable(),
  daysOverdue: z.number().int().min(0),
  settlement: SettlementStatusSchema,
});
export type InvoiceSettlement = z.infer<typeof InvoiceSettlementSchema>;

/** A customer's unallocated credit in one currency (A6: no cross-currency allocation). */
export const CustomerAdvanceSchema = z.object({
  customerId: z.guid(),
  currency: CurrencySchema,
  amount: NonNegativeDecimalString,
});
export type CustomerAdvance = z.infer<typeof CustomerAdvanceSchema>;

const AgingBucketsSchema = z.strictObject({
  current: DecimalString,
  d1_30: DecimalString,
  d31_60: DecimalString,
  d61_90: DecimalString,
  d91_plus: DecimalString,
});

export const ArAgingRowSchema = z.object({
  customerId: z.guid(),
  customerName: z.string().min(1),
  currency: CurrencySchema,
  buckets: AgingBucketsSchema,
  totalOpen: DecimalString,
});
export type ArAgingRow = z.infer<typeof ArAgingRowSchema>;

/** The aging report as of one Kathmandu date. Currencies are never added together. */
export const ArAgingReportSchema = z.object({
  asOf: isoDate,
  rows: z.array(ArAgingRowSchema),
  totals: z.array(
    z.object({ currency: CurrencySchema, buckets: AgingBucketsSchema, totalOpen: DecimalString }),
  ),
});
export type ArAgingReport = z.infer<typeof ArAgingReportSchema>;

// ---------------------------------------------------------------------------------------------
// Bodies (an `Idempotency-Key` header goes with every command; it is not a body field)
// ---------------------------------------------------------------------------------------------

const paymentFields = {
  currency: CurrencySchema,
  amount: PositiveDecimalString,
  tdsWithheld: NonNegativeDecimalString.default('0.00'),
  withholdingCode: z.string().trim().min(1).max(40).optional(),
  method: PaymentMethodSchema,
  receivedOn: isoDate,
  bankReference: text(100).optional(),
  /** Proof is required: a payment without a bank slip or receipt cannot be verified. */
  proofDocumentIds: z.array(z.guid()).min(1).max(10),
};

const withholdingChecks = (
  b: { tdsWithheld: string; withholdingCode?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (Number(b.tdsWithheld) > 0 && b.withholdingCode === undefined) {
    ctx.addIssue({
      code: 'custom',
      path: ['withholdingCode'],
      message: 'name the withholding code when tax was withheld',
    });
  }
};

/** Staff entry: the customer is named in the body. */
export const SubmitPaymentBodySchema = z
  .strictObject({ customerId: z.guid(), ...paymentFields })
  .superRefine(withholdingChecks);
export type SubmitPaymentBody = z.infer<typeof SubmitPaymentBodySchema>;

/** Portal upload: the customer comes from the signed-in principal, never from the body. */
export const PortalSubmitPaymentBodySchema = z
  .strictObject(paymentFields)
  .superRefine(withholdingChecks);
export type PortalSubmitPaymentBody = z.infer<typeof PortalSubmitPaymentBodySchema>;

export const VerifyPaymentBodySchema = z.strictObject({ expectedVersion });
export type VerifyPaymentBody = z.infer<typeof VerifyPaymentBodySchema>;

export const RejectPaymentBodySchema = z.strictObject({ expectedVersion, reason: text(1000) });
export type RejectPaymentBody = z.infer<typeof RejectPaymentBodySchema>;

export const WithdrawPaymentBodySchema = z.strictObject({ expectedVersion });
export type WithdrawPaymentBody = z.infer<typeof WithdrawPaymentBodySchema>;

/** A bounced cheque or an erroneous receipt. Deallocates first, in the same transaction. */
export const ReversePaymentBodySchema = z.strictObject({ expectedVersion, reason: text(1000) });
export type ReversePaymentBody = z.infer<typeof ReversePaymentBodySchema>;

/** Spread a verified payment over issued invoices of the same customer and currency. */
export const AllocatePaymentBodySchema = z.strictObject({
  lines: z
    .array(z.strictObject({ invoiceId: z.guid(), amount: PositiveDecimalString }))
    .min(1)
    .max(50)
    .refine(
      (l) => new Set(l.map((x) => x.invoiceId)).size === l.length,
      'each invoice appears once',
    ),
});
export type AllocatePaymentBody = z.infer<typeof AllocatePaymentBodySchema>;

export const DeallocateBodySchema = z.strictObject({ reason: text(1000) });
export type DeallocateBody = z.infer<typeof DeallocateBodySchema>;
