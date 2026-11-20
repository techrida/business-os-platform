// The quotation lifecycle API this screen uses from the round 4 API work: Cancel quotation, the staff
// confirmation of a portal acceptance's evidence, and the refusal of a schedule with a 0.00 instalment.
// Every path, field name and error code the workspace relies on for them lives in this one file. Pure (no
// server-only import): the page, the server actions and the tests all read it.
//
// - Cancel is `POST /v1/quotations/:id/cancel` with an Idempotency-Key and `{ reason, expectedVersion }`,
//   where `expectedVersion` is the current version row's `version`, the same guard Revise uses. Allowed
//   on a Draft, Returned or Submitted version; cancelling a Submitted one also cancels its open approval
//   request. The detail answer's optional `capabilities.canCancel` decides the button; absent means no.
// - Submit refuses a schedule whose instalment would be 0.00 with 422 `PAYMENT_INSTALMENT_ZERO`,
//   `details: { label, total }`.
// - The evidence of an accepted version is `GET /v1/quotations/:id/versions/:vid/evidence`
//   (`QuotationEvidenceDto`; 404 when there is no acceptance or it is out of scope). A portal acceptance
//   is `pending` until a staff member confirms it with `POST .../evidence-confirmation`, an
//   Idempotency-Key and `{ evidenceKinds, comment? }`; a staff-recorded acceptance is `confirmed` at once.
//   The contract type lands with that API work, so the shape is read here with a lenient local schema.
import {
  EvidenceKindSchema,
  type EvidenceKind,
  type QuotationDetail,
  type QuotationStatus,
} from '@bos/contracts';
import { z } from 'zod';

const q = (id: string): string => `/v1/quotations/${encodeURIComponent(id)}`;
const v = (quotationId: string, versionId: string): string =>
  `${q(quotationId)}/versions/${encodeURIComponent(versionId)}`;

export const lifecyclePaths = {
  cancel: (quotationId: string): string => `${q(quotationId)}/cancel`,
  evidence: (quotationId: string, versionId: string): string =>
    `${v(quotationId, versionId)}/evidence`,
  confirmEvidence: (quotationId: string, versionId: string): string =>
    `${v(quotationId, versionId)}/evidence-confirmation`,
} as const;

/** The statuses Cancel quotation is offered on: the `cancel` edges of the version state machine. */
export const CANCELLABLE_STATUSES: readonly QuotationStatus[] = ['draft', 'returned', 'submitted'];

export const isCancellable = (status: QuotationStatus): boolean =>
  CANCELLABLE_STATUSES.includes(status);

/** The API codes for "an instalment would round to 0.00" on submit (FR-4). */
export const ZERO_INSTALMENT_CODES: readonly string[] = [
  'PAYMENT_INSTALMENT_ZERO',
  'PAYMENT_SCHEDULE_ZERO_INSTALMENT',
  'payment_schedule_zero_instalment',
  'ZERO_INSTALMENT',
];

/** Also recognised by its words, in case the code differs: "instalment" (or "installment") and "0.00". */
const ZERO_INSTALMENT_WORDS = /instal{1,2}ment[\s\S]*\b0\.00\b|\b0\.00\b[\s\S]*instal{1,2}ment/i;

export function isZeroInstalmentRefusal(code: string, message: string): boolean {
  return ZERO_INSTALMENT_CODES.includes(code) || ZERO_INSTALMENT_WORDS.test(message);
}

export const ZERO_INSTALMENT_MESSAGE =
  'At least one payment milestone would come to 0.00 at this total. Remove that milestone or raise its share, then submit again. Nothing was submitted.';

/**
 * The field of the detail answer that the contract does not describe yet. Lenient: anything malformed
 * reads as absent, so the rest of the page is never affected.
 */
const ExtrasSchema = z.object({
  capabilities: z
    .object({ canCancel: z.boolean().optional().catch(undefined) })
    .optional()
    .catch(undefined),
});

export interface QuotationLifecycle {
  canCancel?: boolean | undefined;
}

/** Reads the lifecycle fields from the raw detail body (the contract's parse drops them). */
export function readLifecycle(body: unknown): QuotationLifecycle {
  const parsed = ExtrasSchema.safeParse(body);
  return parsed.success ? { canCancel: parsed.data.capabilities?.canCancel } : {};
}

/** The detail answer with the lifecycle fields kept beside it. */
export type QuotationDetailWithLifecycle = QuotationDetail & { lifecycle?: QuotationLifecycle };

const NONE: QuotationLifecycle = {};

export function lifecycleOf(detail: QuotationDetailWithLifecycle): QuotationLifecycle {
  return detail.lifecycle ?? NONE;
}

/**
 * Cancel quotation is offered on a Draft, Returned or Submitted version only when the API says this caller
 * may cancel it (`capabilities.canCancel`). An answer without the field offers nothing.
 */
export function mayCancel(status: QuotationStatus, lifecycle: QuotationLifecycle): boolean {
  return isCancellable(status) && lifecycle.canCancel === true;
}

// ---- Acceptance evidence (F1-Q28) ------------------------------------------------------------

const kinds = z.array(z.unknown()).transform((list) =>
  list.flatMap((k) => {
    const kind = EvidenceKindSchema.safeParse(k);
    return kind.success ? [kind.data] : [];
  }),
);

/** The parts of `QuotationEvidenceDto` this screen shows. A kind it does not know is left out. */
export const QuotationEvidenceSchema = z.object({
  status: z.enum(['pending', 'confirmed']),
  /** The company's evidence policy now: one kind, `both`, or `none`. */
  policy: z.string(),
  missing: kinds,
  acceptance: z.object({
    actorKind: z.string(),
    acceptedByName: z.string().nullable().optional(),
    evidenceKinds: kinds,
  }),
  confirmation: z
    .object({
      evidenceKinds: kinds,
      comment: z.string().nullable().optional(),
      confirmedBy: z.string(),
      confirmedAt: z.string(),
    })
    .nullable(),
  can: z.object({ confirm: z.boolean() }).catch({ confirm: false }),
});
export type QuotationEvidence = z.infer<typeof QuotationEvidenceSchema>;

/** The kinds the company's evidence policy asks for: `both` is a contract and a purchase order. */
export function policyKinds(policy: string): EvidenceKind[] {
  if (policy === 'both') return ['contract', 'purchase_order'];
  const kind = EvidenceKindSchema.safeParse(policy);
  return kind.success ? [kind.data] : [];
}

/** Words for the evidence confirmation's refusals, or undefined to use the general ones. */
export function evidenceRefusal(status: number, code: string): string | undefined {
  if (status === 422 && code === 'evidence_policy_unmet') {
    return "The evidence you ticked does not meet your company's evidence policy. Tick everything the policy asks for that you hold, then confirm again. Nothing was confirmed.";
  }
  if (status === 409 && code === 'evidence_already_confirmed') {
    return 'Someone has already confirmed this evidence. Reload the page to see who.';
  }
  if (status === 409 && code === 'quotation_not_accepted') {
    return 'This revision is no longer accepted, so there is no evidence to confirm. Reload the page.';
  }
  return undefined;
}
