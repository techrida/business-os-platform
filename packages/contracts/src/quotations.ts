// Contracts for quotations: a parent with immutable, numbered versions. Serves the NFR "amounts are
// exact": quantities are numeric(18,4) strings, money is numeric(18,2) strings, never JS numbers.
// Only Draft and Returned versions are editable; every later change is a revision with a reason.
import { z } from 'zod';

import { CurrencySchema, DecimalString, NprSnapshotSchema } from './money.js';

const isoDateTime = z.iso.datetime({ offset: true });
const isoDate = z.iso.date();

const text = (max: number) => z.string().trim().min(1).max(max);
const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);

// ---------------------------------------------------------------------------------------------
// Numeric strings
// ---------------------------------------------------------------------------------------------

/** A quantity: numeric(18,4) and above zero. A string, because a float cannot hold 0.1 exactly. */
export const QuantityString = z
  .string()
  .regex(/^\d{1,14}(\.\d{1,4})?$/)
  .refine((s) => /[1-9]/.test(s), 'must be above zero');
export type QuantityString = z.infer<typeof QuantityString>;

/** Money that is zero or more: numeric(18,2). `DecimalString` allows a sign, which a price must not have. */
export const NonNegativeDecimalString = DecimalString.refine(
  (s) => !s.startsWith('-'),
  'must not be negative',
);
export type NonNegativeDecimalString = z.infer<typeof NonNegativeDecimalString>;

/** A tax rate in percent: numeric(7,4). Internal screens only; the customer view calls it `percent`. */
const TaxRatePercent = z.string().regex(/^\d{1,3}(\.\d{1,4})?$/);

/** A percentage from 0 to 100 with up to 4 decimals (the discount input is numeric(18,4)). */
const PercentFourDecimals = z.string().regex(/^(?:\d{1,2}(?:\.\d{1,4})?|100(?:\.0{1,4})?)$/);

/** A percentage from 0 to 100 with up to 2 decimals (a payment milestone). */
const PercentTwoDecimals = z.string().regex(/^(?:\d{1,2}(?:\.\d{1,2})?|100(?:\.0{1,2})?)$/);

/** "33.3" becomes 3330 (hundredths), so milestones add up in integers. Input is already validated. */
function toHundredths(percent: string): number {
  const [whole = '0', frac = ''] = percent.split('.');
  return Number(whole) * 100 + Number(frac.padEnd(2, '0'));
}

// ---------------------------------------------------------------------------------------------
// Statuses, transitions, revision rules
// ---------------------------------------------------------------------------------------------

/** Ten states (A2 C1). Superseded keeps a revised version readable. */
export const QUOTATION_STATUSES = [
  'draft',
  'submitted',
  'returned',
  'approved',
  'sent',
  'accepted',
  'rejected',
  'expired',
  'cancelled',
  'superseded',
] as const;
export const QuotationStatusSchema = z.enum(QUOTATION_STATUSES);
export type QuotationStatus = z.infer<typeof QuotationStatusSchema>;

/** Who turned the version down. One `rejected` state serves both (A2 C2). */
export const REJECTION_SOURCES = ['internal', 'customer'] as const;
export const RejectionSourceSchema = z.enum(REJECTION_SOURCES);
export type RejectionSource = z.infer<typeof RejectionSourceSchema>;

export const QUOTATION_ACTIONS = [
  'submit',
  'resubmit',
  'return',
  'withdraw',
  'reject',
  'approve',
  'send',
  'accept',
  'customer_reject',
  'cascade_reject',
  'expire',
  'revise',
  'cancel',
] as const;
export type QuotationAction = (typeof QUOTATION_ACTIONS)[number];

export type QuotationTransition = {
  action: QuotationAction;
  from: QuotationStatus;
  to: QuotationStatus;
  /** Who may do it: a permitted user, or the system (the expiry job, a Lost opportunity). */
  by: 'user' | 'system';
  reasonRequired: boolean;
};

function edge(
  action: QuotationAction,
  from: QuotationStatus,
  to: QuotationStatus,
  reasonRequired = false,
  by: 'user' | 'system' = 'user',
): QuotationTransition {
  return { action, from, to, by, reasonRequired };
}

/**
 * The version state machine of A2 section 2.2. Approval steps are not states: a Submitted version
 * stays Submitted while the kernel request runs (A2 C3). `cascade_reject` is the Lost-opportunity
 * cascade; a Submitted version is first withdrawn to Returned, then cancelled.
 */
export const QUOTATION_TRANSITIONS: readonly QuotationTransition[] = [
  edge('submit', 'draft', 'submitted'),
  edge('resubmit', 'returned', 'submitted'),
  edge('return', 'submitted', 'returned', true),
  edge('withdraw', 'submitted', 'returned'),
  edge('reject', 'submitted', 'rejected', true),
  edge('approve', 'submitted', 'approved'),
  edge('send', 'approved', 'sent'),
  edge('accept', 'sent', 'accepted'),
  edge('customer_reject', 'sent', 'rejected', true),
  edge('cascade_reject', 'approved', 'rejected', true, 'system'),
  edge('cascade_reject', 'sent', 'rejected', true, 'system'),
  edge('expire', 'approved', 'expired', false, 'system'),
  edge('expire', 'sent', 'expired', false, 'system'),
  edge('revise', 'approved', 'superseded', true),
  edge('revise', 'sent', 'superseded', true),
  edge('cancel', 'draft', 'cancelled', true),
  edge('cancel', 'returned', 'cancelled', true),
];

export function quotationTransitionsFrom(status: QuotationStatus): QuotationTransition[] {
  return QUOTATION_TRANSITIONS.filter((t) => t.from === status);
}

/**
 * Revision rules as data (A2 section 2.3, C15). A revision copies the whole version into a new
 * Draft with the next revision number and a mandatory reason. Accepted is not revisable: a change
 * after acceptance is a change request. Only Approved and Sent become Superseded; revising a
 * Rejected or Expired version leaves it as it is.
 */
export const QUOTATION_REVISION_RULES = {
  editableStatuses: ['draft', 'returned'],
  reviseFrom: ['approved', 'sent', 'rejected', 'expired'],
  supersededOnRevise: ['approved', 'sent'],
  /** At most one version per quotation may be in these statuses (a unique index in the database). */
  liveStatuses: ['draft', 'submitted', 'returned', 'approved', 'sent'],
  newVersionStatus: 'draft',
  reasonRequired: true,
} as const satisfies {
  editableStatuses: readonly QuotationStatus[];
  reviseFrom: readonly QuotationStatus[];
  supersededOnRevise: readonly QuotationStatus[];
  liveStatuses: readonly QuotationStatus[];
  newVersionStatus: QuotationStatus;
  reasonRequired: boolean;
};

export const isQuotationEditable = (s: QuotationStatus): boolean =>
  (QUOTATION_REVISION_RULES.editableStatuses as readonly QuotationStatus[]).includes(s);
export const canReviseQuotation = (s: QuotationStatus): boolean =>
  (QUOTATION_REVISION_RULES.reviseFrom as readonly QuotationStatus[]).includes(s);

// ---------------------------------------------------------------------------------------------
// Lines, discount, payment schedule
// ---------------------------------------------------------------------------------------------

/**
 * One line as the client sends it. There is no per-line discount: the discount sits on the
 * quotation (A2 C5). `unitCost` is internal and never reaches the customer.
 */
export const QuotationLineInputSchema = z.strictObject({
  catalogItemId: z.guid().optional(),
  description: text(500),
  uom: text(20),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  unitCost: NonNegativeDecimalString.optional(),
  taxCodeId: z.guid(),
});
export type QuotationLineInput = z.infer<typeof QuotationLineInputSchema>;

/** A line as the server returns it: the input plus the figures the pricing function computed. */
export const QuotationLineDtoSchema = z.object({
  lineNo: z.number().int().min(1),
  catalogItemId: z.guid().nullable(),
  description: z.string(),
  uom: z.string(),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  unitCost: NonNegativeDecimalString.nullable(),
  taxCodeId: z.guid(),
  gross: DecimalString,
  discountAlloc: DecimalString,
  taxable: DecimalString,
});
export type QuotationLineDto = z.infer<typeof QuotationLineDtoSchema>;

/** The one discount on a quotation: a percentage (0 to 100) or an amount. */
export const DiscountSchema = z.discriminatedUnion('mode', [
  z.strictObject({ mode: z.literal('pct'), value: PercentFourDecimals }),
  z.strictObject({ mode: z.literal('amount'), value: NonNegativeDecimalString }),
]);
export type Discount = z.infer<typeof DiscountSchema>;

export const PaymentMilestoneSchema = z.strictObject({
  label: text(100),
  percent: PercentTwoDecimals,
  dueDescription: text(200).optional(),
});
export type PaymentMilestone = z.infer<typeof PaymentMilestoneSchema>;

// ---------------------------------------------------------------------------------------------
// Draft content (the material fields) and bodies
// ---------------------------------------------------------------------------------------------

const contentObject = z.strictObject({
  contactId: z.guid().optional(),
  templateId: z.guid().optional(),
  currency: CurrencySchema,
  issueDate: isoDate,
  validUntil: isoDate,
  scope: text(10000).optional(),
  assumptions: text(10000).optional(),
  exclusions: text(10000).optional(),
  deliveryTimeline: text(2000).optional(),
  paymentTermId: z.guid().optional(),
  paymentSchedule: z.array(PaymentMilestoneSchema).max(12).optional(),
  discount: DiscountSchema.optional(),
  lines: z.array(QuotationLineInputSchema).min(1).max(500),
  attachmentDocumentIds: z.array(z.guid()).max(20).optional(),
});

type ContentChecks = {
  issueDate?: string | undefined;
  validUntil?: string | undefined;
  paymentSchedule?: { percent: string }[] | undefined;
};

/** ISO dates sort as text, so a plain comparison is exact. A schedule, when present, adds up to 100%. */
function contentChecks(c: ContentChecks, ctx: z.RefinementCtx): void {
  if (c.issueDate !== undefined && c.validUntil !== undefined && c.validUntil < c.issueDate) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'must not be before issueDate' });
  }
  if (c.paymentSchedule !== undefined && c.paymentSchedule.length > 0) {
    const sum = c.paymentSchedule.reduce((n, m) => n + toHundredths(m.percent), 0);
    if (sum !== 10000) {
      ctx.addIssue({
        code: 'custom',
        path: ['paymentSchedule'],
        message: 'milestones must add up to 100%',
      });
    }
  }
}

/** The editable content of a version. Money here is exactly what the user typed; totals are the server's. */
export const QuotationVersionContentSchema = contentObject.superRefine(contentChecks);
export type QuotationVersionContent = z.infer<typeof QuotationVersionContentSchema>;

/** A new quotation starts as Draft revision 1 on an opportunity; the customer comes from it. */
export const CreateQuotationBodySchema = contentObject
  .extend({ opportunityId: z.guid() })
  .superRefine(contentChecks);
export type CreateQuotationBody = z.infer<typeof CreateQuotationBodySchema>;

export const UpdateQuotationDraftBodySchema = contentObject
  .partial()
  .extend({
    /** The row version the client saw; a different current version means 409. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine(contentChecks);
export type UpdateQuotationDraftBody = z.infer<typeof UpdateQuotationDraftBodySchema>;

/** Ask the server for totals without saving. The web app shows this and never does the maths itself. */
export const QuotationPreviewBodySchema = z.strictObject({
  currency: CurrencySchema,
  discount: DiscountSchema.optional(),
  lines: z.array(QuotationLineInputSchema).min(1).max(500),
});
export type QuotationPreviewBody = z.infer<typeof QuotationPreviewBodySchema>;

const expectedVersion = z.number().int().min(1);

export const SubmitQuotationBodySchema = z.strictObject({ expectedVersion });
export type SubmitQuotationBody = z.infer<typeof SubmitQuotationBodySchema>;

/** The creator pulls a Submitted version back to Returned to improve it. */
export const WithdrawQuotationBodySchema = z.strictObject({
  reason: text(1000).optional(),
  expectedVersion,
});
export type WithdrawQuotationBody = z.infer<typeof WithdrawQuotationBodySchema>;

export const ReviseQuotationBodySchema = z.strictObject({
  reason: text(1000),
  expectedVersion,
});
export type ReviseQuotationBody = z.infer<typeof ReviseQuotationBodySchema>;

export const CancelQuotationBodySchema = z.strictObject({
  reason: text(1000),
  expectedVersion,
});
export type CancelQuotationBody = z.infer<typeof CancelQuotationBodySchema>;

/** Send the approved, frozen version. The email carries a portal link, never the file. */
export const SendQuotationBodySchema = z.strictObject({
  recipientContactId: z.guid(),
  message: text(2000).optional(),
  expectedVersion,
});
export type SendQuotationBody = z.infer<typeof SendQuotationBodySchema>;

// ---------------------------------------------------------------------------------------------
// Acceptance
// ---------------------------------------------------------------------------------------------

/**
 * What proves a customer accepted. "Both" or any combination is a policy over these kinds
 * (`sales.evidence_policy`), not a kind of its own. D18: the default policy asks for a signed quote.
 */
export const EVIDENCE_KINDS = ['contract', 'purchase_order', 'signed_quote'] as const;
export const EvidenceKindSchema = z.enum(EVIDENCE_KINDS);
export type EvidenceKind = z.infer<typeof EvidenceKindSchema>;

export const ACCEPTANCE_OUTCOMES = ['accepted', 'rejected'] as const;
export const AcceptanceOutcomeSchema = z.enum(ACCEPTANCE_OUTCOMES);

/** Staff record the outcome today; `customer_user` is for the portal. The server sets it, not the client. */
export const ACTOR_KINDS = ['staff', 'customer_user'] as const;
export const ActorKindSchema = z.enum(ACTOR_KINDS);

/**
 * Record the customer's answer. Accepting needs at least one evidence kind (a choice: the policy
 * decides whether the kinds are enough for Won). Rejecting needs a comment and may have no evidence.
 */
export const RecordOutcomeBodySchema = z
  .strictObject({
    outcome: AcceptanceOutcomeSchema,
    decidedOn: isoDate,
    comment: text(2000).optional(),
    evidenceKinds: z
      .array(EvidenceKindSchema)
      .max(EVIDENCE_KINDS.length)
      .refine((kinds) => new Set(kinds).size === kinds.length, 'each evidence kind at most once')
      .default([]),
    /** The evidence files, uploaded through the document service. */
    evidenceDocumentIds: z.array(z.guid()).max(20).optional(),
    expectedVersion,
  })
  .superRefine((body, ctx) => {
    if (body.outcome === 'accepted' && body.evidenceKinds.length === 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['evidenceKinds'],
        message: 'at least one evidence kind is required to accept',
      });
    }
    if (body.outcome === 'rejected' && body.comment === undefined) {
      ctx.addIssue({
        code: 'custom',
        path: ['comment'],
        message: 'a comment is required to reject',
      });
    }
  });
export type RecordOutcomeBody = z.infer<typeof RecordOutcomeBodySchema>;

export const AcceptanceDtoSchema = z.object({
  id: z.guid(),
  versionId: z.guid(),
  outcome: AcceptanceOutcomeSchema,
  actorKind: ActorKindSchema,
  actorId: z.guid(),
  decidedOn: isoDate,
  comment: z.string().nullable(),
  evidenceKinds: z.array(EvidenceKindSchema),
  evidenceDocumentIds: z.array(z.guid()),
});
export type AcceptanceDto = z.infer<typeof AcceptanceDtoSchema>;

// ---------------------------------------------------------------------------------------------
// DTOs (internal: they carry cost and margin, so they need a staff permission; never the portal)
// ---------------------------------------------------------------------------------------------

/** One row of the tax summary: tax is rounded once per tax code, not per line. */
export const QuotationTaxSummaryItemSchema = z.object({
  taxCodeId: z.guid(),
  label: z.string(),
  rate: TaxRatePercent,
  base: DecimalString,
  tax: DecimalString,
});
export type QuotationTaxSummaryItem = z.infer<typeof QuotationTaxSummaryItemSchema>;

export const QuotationTotalsSchema = z.object({
  subtotal: DecimalString,
  discountAmount: DecimalString,
  taxableAmount: DecimalString,
  taxAmount: DecimalString,
  total: DecimalString,
  /** Effective discount in percent, 4 decimals; the 12% rule compares it unrounded on the server. */
  effectiveDiscountPct: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
});
export type QuotationTotals = z.infer<typeof QuotationTotalsSchema>;

export const QuotationVersionDtoSchema = z
  .object({
    id: z.guid(),
    quotationId: z.guid(),
    /** The parent number, for example QT-2082-0042; a version shows as "QT-2082-0042 Rev 2". */
    number: z.string().min(1).max(32),
    revisionNo: z.number().int().min(1),
    status: QuotationStatusSchema,
    /** Set exactly when the status is `rejected`. */
    rejectionSource: RejectionSourceSchema.nullable(),
    customerId: z.guid(),
    contactId: z.guid().nullable(),
    templateId: z.guid().nullable(),
    currency: CurrencySchema,
    issueDate: isoDate,
    validUntil: isoDate,
    scope: z.string().nullable(),
    assumptions: z.string().nullable(),
    exclusions: z.string().nullable(),
    deliveryTimeline: z.string().nullable(),
    paymentTermId: z.guid().nullable(),
    paymentSchedule: z.array(PaymentMilestoneSchema),
    discount: DiscountSchema.nullable(),
    lines: z.array(QuotationLineDtoSchema),
    taxSummary: z.array(QuotationTaxSummaryItemSchema),
    totals: QuotationTotalsSchema,
    internalCostTotal: DecimalString.nullable(),
    marginPct: z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,4})?$/)
      .nullable(),
    /** The NPR equivalent frozen with its rate; null for NPR documents. */
    nprSnapshot: NprSnapshotSchema.nullable(),
    approvalRequestId: z.guid().nullable(),
    /** SHA-256 of the canonical material-fields JSON, the same value the approval request froze. */
    snapshotSha256: sha256Hex.nullable(),
    renderedDocumentId: z.guid().nullable(),
    renderedSha256: sha256Hex.nullable(),
    supersedesVersionId: z.guid().nullable(),
    supersededByVersionId: z.guid().nullable(),
    revisionReason: z.string().nullable(),
    cancelReason: z.string().nullable(),
    submittedAt: isoDateTime.nullable(),
    approvedAt: isoDateTime.nullable(),
    sentAt: isoDateTime.nullable(),
    acceptedAt: isoDateTime.nullable(),
    rejectedAt: isoDateTime.nullable(),
    expiredAt: isoDateTime.nullable(),
    cancelledAt: isoDateTime.nullable(),
    version: z.number().int().min(1),
    createdAt: isoDateTime,
    updatedAt: isoDateTime,
  })
  .refine((v) => (v.status === 'rejected') === (v.rejectionSource !== null), {
    path: ['rejectionSource'],
    message: 'a rejection source is present exactly when the status is rejected',
  });
export type QuotationVersionDto = z.infer<typeof QuotationVersionDtoSchema>;

/** The parent. Its status is derived from the current version, never stored twice (A2 D2). */
export const QuotationDtoSchema = z.object({
  id: z.guid(),
  number: z.string().min(1).max(32),
  customerId: z.guid(),
  opportunityId: z.guid(),
  currentVersionId: z.guid(),
  ownerUserId: z.guid().nullable(),
  status: QuotationStatusSchema,
  version: z.number().int().min(1),
  createdAt: isoDateTime,
  updatedAt: isoDateTime,
});
export type QuotationDto = z.infer<typeof QuotationDtoSchema>;

export const QuotationStatusHistoryDtoSchema = z.object({
  versionId: z.guid(),
  fromStatus: QuotationStatusSchema.nullable(),
  toStatus: QuotationStatusSchema,
  actorId: z.guid().nullable(),
  reason: z.string().nullable(),
  at: isoDateTime,
});
export type QuotationStatusHistoryDto = z.infer<typeof QuotationStatusHistoryDtoSchema>;
