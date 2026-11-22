// Contracts for quotations: a parent with immutable, numbered versions. Serves the NFR "amounts are
// exact": quantities are numeric(18,4) strings, money is numeric(18,2) strings, never JS numbers.
// Only Draft and Returned versions are editable; every later change is a revision with a reason.
import { z } from 'zod';

import { PersonNameSchema, RoutePlanSchema } from './approvals.js';
import { RoleKeySchema } from './authz.js';
import { DocumentVersionStatusSchema } from './documents.js';
import { multi, searchParam } from './list-query.js';
import { CurrencySchema, DecimalString, NprSnapshotSchema, RateString } from './money.js';
import { decimalPattern, PERCENT_LIMITS, QUANTITY_LIMITS } from './number-limits.js';
import { richTextSchema } from './rich-text.js';

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
  .regex(decimalPattern(QUANTITY_LIMITS))
  .refine((s) => /[1-9]/.test(s), 'must be above zero');
export type QuantityString = z.infer<typeof QuantityString>;

/** Money that is zero or more: numeric(18,2). `DecimalString` allows a sign, which a price must not have. */
export const NonNegativeDecimalString = DecimalString.refine(
  (s) => !s.startsWith('-'),
  'must not be negative',
);
export type NonNegativeDecimalString = z.infer<typeof NonNegativeDecimalString>;

/** A tax rate in percent: numeric(7,4). Internal screens only; the customer view calls it `percent`. */
const TaxRatePercent = z.string().regex(decimalPattern(PERCENT_LIMITS));

/** A percentage from 0 to 100 with up to 4 decimals (the discount input is numeric(18,4)). */
export const PercentFourDecimals = z.string().regex(/^(?:\d{1,2}(?:\.\d{1,4})?|100(?:\.0{1,4})?)$/);

export const PAYMENT_PERCENT_SCALE = 10_000;
export const FULL_PAYMENT_PERCENT_UNITS = 100 * PAYMENT_PERCENT_SCALE;

/** "33.3334" becomes 333334. Input has already passed PercentFourDecimals. */
export function paymentPercentUnits(percent: string): number {
  const [whole = '0', fraction = ''] = percent.split('.');
  return Number(whole) * PAYMENT_PERCENT_SCALE + Number(fraction.padEnd(4, '0'));
}

/** Trim the insignificant fractional zeros without rounding a decimal string. */
export function trimPercent(percent: string): string {
  if (!percent.includes('.')) return percent;
  const trimmed = percent.replace(/0+$/, '').replace(/\.$/, '');
  return trimmed === '' || trimmed === '-' ? '0' : trimmed;
}

export function formatPaymentPercentUnits(units: number): string {
  const whole = Math.floor(units / PAYMENT_PERCENT_SCALE);
  const fraction = String(units % PAYMENT_PERCENT_SCALE).padStart(4, '0');
  return trimPercent(`${whole}.${fraction}`);
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
  'reject',
  'approve',
  'send',
  'accept',
  'customer_reject',
  'cascade_reject',
  'expire',
  'revise',
  'cancel',
  'cancel_on_lost',
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
 * stays Submitted while the kernel request runs (A2 C3). `cascade_reject` was the original Lost-opportunity
 * cascade for an Approved or Sent version; nothing runs it, and the Lost cascade uses `cancel_on_lost` (R5 FU12).
 * `cancel` ends a quotation that has not been approved yet (Kuu, F1-Q27: Cancel only, no
 * Recall): a Draft, a Returned one, or a Submitted one, whose open approval request is cancelled with it.
 */
export const QUOTATION_TRANSITIONS: readonly QuotationTransition[] = [
  edge('submit', 'draft', 'submitted'),
  edge('resubmit', 'returned', 'submitted'),
  edge('return', 'submitted', 'returned', true),
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
  edge('cancel', 'submitted', 'cancelled', true),
  // A Lost opportunity ends every quotation still open on it, including an Approved or Sent one that a user may
  // not cancel by hand: the customer must stop being able to accept a deal the company has closed.
  edge('cancel_on_lost', 'draft', 'cancelled', true, 'system'),
  edge('cancel_on_lost', 'returned', 'cancelled', true, 'system'),
  edge('cancel_on_lost', 'submitted', 'cancelled', true, 'system'),
  edge('cancel_on_lost', 'approved', 'cancelled', true, 'system'),
  edge('cancel_on_lost', 'sent', 'cancelled', true, 'system'),
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
/** A version in `s` may be cancelled (QUOTATION_TRANSITIONS: Draft, Returned or Submitted). */
export const canCancelQuotation = (s: QuotationStatus): boolean =>
  QUOTATION_TRANSITIONS.some((t) => t.action === 'cancel' && t.from === s);
/** A version in `s` is ended by a Lost opportunity: every live status (Draft, Returned, Submitted, Approved, Sent). */
export const canCancelOnLost = (s: QuotationStatus): boolean =>
  QUOTATION_TRANSITIONS.some((t) => t.action === 'cancel_on_lost' && t.from === s);

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

/**
 * A line as the server returns it: the input plus the figures the pricing function computed.
 * `unitCost`: null means no cost is recorded; absent means the viewer lacks `quotation.cost.read`.
 */
export const QuotationLineDtoSchema = z.object({
  lineNo: z.number().int().min(1),
  catalogItemId: z.guid().nullable(),
  description: z.string(),
  uom: z.string(),
  quantity: QuantityString,
  unitPrice: NonNegativeDecimalString,
  unitCost: NonNegativeDecimalString.nullable().optional(),
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
  percent: PercentFourDecimals,
  dueDescription: text(200).optional(),
});
export type PaymentMilestone = z.infer<typeof PaymentMilestoneSchema>;

/**
 * A milestone as the API returns it (D36): the stored milestone plus its `amount`, in the document currency.
 * The server splits the version total by the percents (D22: two decimals, half up, the remainder on the last
 * row), so every screen, the PDF and the portal show the same figures and none recomputes them. The input
 * `PaymentMilestoneSchema` stays amount-free: an amount is never stored or accepted.
 */
export const PaymentMilestoneDtoSchema = PaymentMilestoneSchema.extend({ amount: DecimalString });
export type PaymentMilestoneDto = z.infer<typeof PaymentMilestoneDtoSchema>;

// ---------------------------------------------------------------------------------------------
// Draft content (the material fields) and bodies
// ---------------------------------------------------------------------------------------------

const contentObject = z.strictObject({
  contactId: z.guid().optional(),
  templateId: z.guid().optional(),
  currency: CurrencySchema,
  issueDate: isoDate,
  validUntil: isoDate,
  scope: richTextSchema(10000).optional(),
  assumptions: richTextSchema(10000).optional(),
  exclusions: richTextSchema(10000).optional(),
  termsAndConditions: richTextSchema(10000).optional(),
  deliveryTimeline: richTextSchema(2000).optional(),
  paymentTermId: z.guid().optional(),
  paymentSchedule: z.array(PaymentMilestoneSchema).max(12).optional(),
  discount: DiscountSchema.optional(),
  lines: z.array(QuotationLineInputSchema).min(1).max(500),
  attachmentDocumentIds: z.array(z.guid()).max(20).optional(),
});

type ContentChecks = {
  issueDate?: string | undefined;
  validUntil?: string | undefined;
  paymentSchedule?: { percent: string }[] | null | undefined;
};

/** ISO dates sort as text, so a plain comparison is exact. A schedule, when present, adds up to 100%. */
function contentChecks(c: ContentChecks, ctx: z.RefinementCtx): void {
  if (c.issueDate !== undefined && c.validUntil !== undefined && c.validUntil < c.issueDate) {
    ctx.addIssue({ code: 'custom', path: ['validUntil'], message: 'must not be before issueDate' });
  }
  if (c.paymentSchedule != null && c.paymentSchedule.length > 0) {
    const sum = c.paymentSchedule.reduce((n, m) => n + paymentPercentUnits(m.percent), 0);
    if (sum !== FULL_PAYMENT_PERCENT_UNITS) {
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

/**
 * PUT is a partial update: an absent key keeps the saved value, and `null` on one of these optional
 * keys clears it (an empty `paymentSchedule` clears the schedule too). Without null a person could
 * never remove a discount or blank a field once saved. The required keys never take null.
 */
export const UpdateQuotationDraftBodySchema = contentObject
  .partial()
  .extend({
    contactId: contentObject.shape.contactId.nullable(),
    scope: contentObject.shape.scope.nullable(),
    assumptions: contentObject.shape.assumptions.nullable(),
    exclusions: contentObject.shape.exclusions.nullable(),
    termsAndConditions: contentObject.shape.termsAndConditions.nullable(),
    deliveryTimeline: contentObject.shape.deliveryTimeline.nullable(),
    paymentTermId: contentObject.shape.paymentTermId.nullable(),
    paymentSchedule: contentObject.shape.paymentSchedule.nullable(),
    discount: contentObject.shape.discount.nullable(),
    /** The row version the client saw; a different current version means 409. */
    expectedVersion: z.number().int().min(1),
  })
  .superRefine(contentChecks);
export type UpdateQuotationDraftBody = z.infer<typeof UpdateQuotationDraftBodySchema>;

/**
 * Body of `PUT /v1/quotations/:id/versions/:vid`: the draft content plus `expectedVersion`. The
 * same schema as `UpdateQuotationDraftBodySchema` under the name of the route it belongs to.
 */
export const UpdateQuotationVersionBodySchema = UpdateQuotationDraftBodySchema;
export type UpdateQuotationVersionBody = UpdateQuotationDraftBody;

/** Ask the server for totals without saving. The web app shows this and never does the maths itself. */
export const QuotationPreviewBodySchema = z.strictObject({
  currency: CurrencySchema,
  discount: DiscountSchema.optional(),
  lines: z.array(QuotationLineInputSchema).min(1).max(500),
});
export type QuotationPreviewBody = z.infer<typeof QuotationPreviewBodySchema>;

const expectedVersion = z.number().int().min(1);

export const SubmitQuotationBodySchema = z.strictObject({
  expectedVersion,
  /**
   * Optional: the one person who decides the first approval step, from the preview's `approverChoice`.
   * Absent: every eligible approver of that step sees it, as before. The server checks it again at submit.
   */
  approverUserId: z.guid().optional(),
});
export type SubmitQuotationBody = z.infer<typeof SubmitQuotationBodySchema>;

export const ReviseQuotationBodySchema = z.strictObject({
  reason: text(1000),
  expectedVersion,
});
export type ReviseQuotationBody = z.infer<typeof ReviseQuotationBodySchema>;

/**
 * End the current version (F1-Q27). The reason is kept on the version and in its history. A Submitted
 * version's open approval request is cancelled in the same transaction.
 */
export const CancelQuotationBodySchema = z.strictObject({
  reason: text(1000),
  expectedVersion,
  /** The revision the caller looked at. A stale page whose revision is no longer current gets 409, not the new revision cancelled. */
  versionId: z.guid().optional(),
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
  /** The name the customer signed with; null for a rejection or a staff entry that has none. */
  acceptedByName: z.string().nullable(),
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
    termsAndConditions: z.string().nullable(),
    deliveryTimeline: z.string().nullable(),
    paymentTermId: z.guid().nullable(),
    paymentSchedule: z.array(PaymentMilestoneDtoSchema),
    discount: DiscountSchema.nullable(),
    lines: z.array(QuotationLineDtoSchema),
    taxSummary: z.array(QuotationTaxSummaryItemSchema),
    totals: QuotationTotalsSchema,
    /**
     * Internal cost figures. null means no cost is recorded; absent means the viewer lacks
     * `quotation.cost.read` (the API omits `internalCostTotal`, `marginPct` and each line's `unitCost`).
     */
    internalCostTotal: DecimalString.nullable().optional(),
    marginPct: z
      .string()
      .regex(/^-?\d{1,3}(\.\d{1,4})?$/)
      .nullable()
      .optional(),
    /** The NPR equivalent frozen with its rate; null for NPR documents. */
    nprSnapshot: NprSnapshotSchema.nullable(),
    approvalRequestId: z.guid().nullable(),
    /** SHA-256 of the canonical material-fields JSON, the same value the approval request froze. */
    snapshotSha256: sha256Hex.nullable(),
    renderedDocumentId: z.guid().nullable(),
    renderedSha256: sha256Hex.nullable(),
    /**
     * The scan status of the rendered PDF's document version, null when none is rendered. Required on
     * purpose: a producer that omits it fails the parse, and a screen offers the PDF link and Send only
     * when it is `clean` (deny by default).
     */
    renderedScanStatus: DocumentVersionStatusSchema.nullable(),
    /**
     * True when the PDF render of this approved version was given up after its last try (round 4, R4c2): the screen
     * shows that it could not be prepared, with Retry for a viewer who may send, instead of "Preparing PDF" for ever.
     * False while it is being rendered or retried, once it is rendered, and for any other status.
     */
    renderFailed: z.boolean(),
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

/**
 * One row of `GET /v1/quotations`: the parent plus what a list needs, so the screen never makes a
 * call per row. `total` is the current version's total, in `currency`. The endpoint returns an array.
 */
export const QuotationListItemSchema = QuotationDtoSchema.extend({
  customerName: z.string().min(1),
  currency: CurrencySchema,
  total: NonNegativeDecimalString,
  validUntil: isoDate,
  ownerName: z.string().nullable(),
  /** The owner's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  ownerAvatarDocumentId: z.guid().nullable().optional(),
  /**
   * The caller may edit the current version now: it is Draft or Returned and the server's
   * `quotation.draft` rule allows this caller on this record. Lets a screen resume a draft instead of
   * starting a second quotation.
   */
  canEdit: z.boolean(),
});
export type QuotationListItem = z.infer<typeof QuotationListItemSchema>;

/**
 * `GET /v1/quotations` query (strict: an unknown key is a 400). `status` and `customerId` repeat
 * (`?status=draft&status=sent`) and match any of the values; `status` is the current version's. `q`
 * searches the number, customer name and owner name. `opportunityId` limits the list to one opportunity's
 * quotations. Every filter narrows what the caller may read, never widens it. Without `limit` every match
 * is returned (at most 200 when given). The body is a bare array and `X-Total-Count` carries the number of
 * all matches.
 */
export const ListQuotationsQuerySchema = z.strictObject({
  status: multi(QuotationStatusSchema),
  customerId: multi(z.guid()),
  opportunityId: z.guid().optional(),
  q: searchParam,
  // No `limit` means every match (the pickers never page); a paged caller sends limit and offset.
  limit: z.coerce.number().int().min(1).max(200).optional(),
  offset: z.coerce.number().int().min(0).default(0),
});
export type ListQuotationsQuery = z.infer<typeof ListQuotationsQuerySchema>;

/**
 * `GET /v1/quotations/summary` query: the list's filters without `status` and paging, so the KPI cards
 * count the same rows the list is filtered to, whatever status is picked.
 */
export const QuotationSummaryQuerySchema = z.strictObject({
  customerId: multi(z.guid()),
  opportunityId: z.guid().optional(),
  q: searchParam,
});
export type QuotationSummaryQuery = z.infer<typeof QuotationSummaryQuerySchema>;

/** The sum of the current versions' totals in one currency. */
export const QuotationAmountSchema = z.object({
  currency: CurrencySchema,
  total: NonNegativeDecimalString,
});
export type QuotationAmount = z.infer<typeof QuotationAmountSchema>;

/** `GET /v1/quotations/summary`: how many quotations match, in total and per current-version status. */
export const QuotationSummarySchema = z.object({
  total: z.number().int().min(0),
  /** Every status is present, zero when none match. */
  byStatus: z.record(QuotationStatusSchema, z.number().int().min(0)),
  /**
   * What those quotations are worth per status: one entry per currency in use, never converted or mixed.
   * Every status is present, an empty list when none match. Left out by an API that predates it.
   */
  amounts: z.record(QuotationStatusSchema, z.array(QuotationAmountSchema)).optional(),
});
export type QuotationSummary = z.infer<typeof QuotationSummarySchema>;

/**
 * What the caller may do with a quotation now, decided by the server with the same rules its
 * commands enforce, so a screen never offers an action that would answer 403 or 409.
 */
export const QuotationCapabilitiesSchema = z.object({
  /** Edit the current version: Draft or Returned, and `quotation.draft` on this record. */
  canEdit: z.boolean(),
  /** Start a revision: a revisable status, and `quotation.revise` on this record. */
  canRevise: z.boolean(),
  /** Send an approved or expired version: `quotation.send` on this record. */
  canSend: z.boolean().optional(),
  /** Record the customer's outcome on a sent version: `quotation.record_acceptance` on this record. */
  canRecordOutcome: z.boolean().optional(),
  /**
   * Cancel the current version (`POST /v1/quotations/:id/cancel`): Draft, Returned or Submitted, and
   * `quotation.draft` on this record. Treat an omitted value as false.
   */
  canCancel: z.boolean().optional(),
});
export type QuotationCapabilities = z.infer<typeof QuotationCapabilitiesSchema>;

/** A customer contact the send dialog can offer as a recipient. */
export const QuotationContactSchema = z.object({
  id: z.guid(),
  name: z.string().min(1),
  /** A contact with no email cannot receive a quotation; the dialog shows it as unusable. */
  email: z.string().nullable(),
});
export type QuotationContact = z.infer<typeof QuotationContactSchema>;

/**
 * The lead a quotation came from (D35): the quotation's opportunity's parent lead. `name` is the lead's title;
 * a screen builds the link from `id`.
 */
export const QuotationLeadSchema = z.strictObject({
  id: z.guid(),
  name: z.string().min(1),
});
export type QuotationLead = z.infer<typeof QuotationLeadSchema>;

/** `GET /v1/quotations/:id`: the parent, every version (Superseded included), history and recipients. */
export const QuotationDetailSchema = z.object({
  quotation: QuotationDtoSchema,
  versions: z.array(QuotationVersionDtoSchema),
  statusHistory: z.array(QuotationStatusHistoryDtoSchema),
  customerName: z.string().min(1),
  contacts: z.array(QuotationContactSchema),
  capabilities: QuotationCapabilitiesSchema,
  /** Names of the people the quotation names: its owner and the actors of its status history. */
  people: z.array(PersonNameSchema).optional(),
  /**
   * The lead behind the quotation's opportunity (D35). Present only when the viewer may read an existing lead
   * (`crm.lead.read` with its scope on the lead's record). Absent: no lead, or not one the viewer may read, so
   * "none" and "hidden" look the same and a hidden lead's existence is not disclosed.
   */
  lead: QuotationLeadSchema.optional(),
});
export type QuotationDetail = z.infer<typeof QuotationDetailSchema>;

/**
 * What an approver sees in the inbox for a quotation, frozen at submission. The API writes it when
 * the version is submitted; the inbox renderer reads it. camelCase, and every money amount and
 * percentage is a string.
 */
export const QuotationApprovalSnapshotSchema = z.object({
  nprTotal: NonNegativeDecimalString,
  effectiveDiscountPct: z.string().regex(/^\d{1,3}(\.\d{1,4})?$/),
  /**
   * Null when no internal cost is recorded, so the margin is unknown rather than zero. Absent when the viewer lacks
   * `quotation.cost.read` (the API removes it when it serves the snapshot; the stored snapshot keeps it).
   */
  marginPct: z
    .string()
    .regex(/^-?\d{1,3}(\.\d{1,4})?$/)
    .nullable()
    .optional(),
  nprDiscountAmount: NonNegativeDecimalString,
  currency: CurrencySchema,
  /** The rate to NPR; "1" for an NPR document. */
  fxRate: RateString,
  customerName: z.string().min(1),
  quotationNumber: z.string().min(1).max(32),
  revisionNo: z.number().int().min(1),
  /**
   * The server's verdict on the discount rule (strictly above 12%, compared unrounded). The inbox
   * reads this flag and never re-derives the rule from the rounded `effectiveDiscountPct` text.
   */
  discountApprovalRequired: z.boolean(),
});
export type QuotationApprovalSnapshot = z.infer<typeof QuotationApprovalSnapshotSchema>;

// ---------------------------------------------------------------------------------------------
// Quote builder: preview result and lookup lists
// ---------------------------------------------------------------------------------------------

/** `POST .../versions/:vid/preview`: server totals plus the approval route dry-run. */
export const PreviewResultSchema = z.object({
  totals: QuotationTotalsSchema,
  taxSummary: z.array(QuotationTaxSummaryItemSchema),
  /** Per-line figures the pricing function computed, when the API sends them. */
  lines: z
    .array(
      QuotationLineDtoSchema.pick({
        lineNo: true,
        gross: true,
        discountAlloc: true,
        taxable: true,
      }),
    )
    .optional(),
  /** The NPR equivalent and its rate, for INR and USD documents. */
  nprSnapshot: NprSnapshotSchema.nullable().optional(),
  /** Who must approve and why (`previewRoute` on the facts of this version). */
  route: RoutePlanSchema.extend({
    steps: z.array(
      RoutePlanSchema.shape.steps.element.extend({
        /** Names only, when the caller may see the preview's eligible people. */
        eligibleStaffNames: z.array(z.string().min(1)).optional(),
      }),
    ),
  }),
  /**
   * Who the author may name as the approver of step `seq` (the first step) of this quotation, or null when that
   * step has nobody to choose between. The author and the caller are never offered.
   */
  approverChoice: z
    .object({
      seq: z.number().int().min(1),
      options: z.array(
        z.object({
          userId: z.guid(),
          name: z.string().min(1),
          /** The role that lets them approve the step (for example accountant, or sales when allowed). */
          roleKey: RoleKeySchema,
          /** False when the person has no email address: they get the bell notice and the inbox item only. */
          hasEmail: z.boolean(),
        }),
      ),
    })
    .nullable()
    .optional(),
});
export type PreviewResult = z.infer<typeof PreviewResultSchema>;
export type ApproverOption = NonNullable<PreviewResult['approverChoice']>['options'][number];

/** The tax code kinds of the `tax_codes` table. */
export const TAX_CODE_KINDS = ['vat', 'exempt', 'zero', 'reverse_charge'] as const;
export const TaxCodeKindSchema = z.enum(TAX_CODE_KINDS);

/**
 * One row of `GET /v1/tax-codes`. The builder needs `id` and `label`; the registry fields are
 * optional so a list that carries them still parses.
 */
export const TaxCodeSchema = z.object({
  id: z.guid(),
  /** Short name such as "VAT 13%". */
  label: z.string(),
  /** Percent, for the label only; the server does the tax maths. */
  rate: z.string().optional(),
  code: z.string().optional(),
  kind: TaxCodeKindSchema.optional(),
  /** Basis points (1300 is 13%). */
  rateBp: z.number().int().min(0).max(10000).optional(),
});
export type TaxCode = z.infer<typeof TaxCodeSchema>;

/** One row of `GET /v1/payment-terms`. */
export const PaymentTermSchema = z.object({ id: z.guid(), label: z.string() });
export type PaymentTerm = z.infer<typeof PaymentTermSchema>;
