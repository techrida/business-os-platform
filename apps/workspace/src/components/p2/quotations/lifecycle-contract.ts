// The round 4 quotation lifecycle as this workspace calls it: Cancel quotation, the staff confirmation of a
// portal acceptance's evidence, and the refusal of a schedule with a 0.00 instalment. Paths, error codes and
// the few rules the screens add live in this one file; the shapes are the contract's own types. Pure (no
// server-only import): the page, the server actions and the tests all read it.
//
// - Cancel is `POST /v1/quotations/:id/cancel` with an Idempotency-Key and `CancelQuotationBody`. The
//   button needs a version the state machine can cancel (`canCancelQuotation`: Draft, Returned, Submitted)
//   and `capabilities.canCancel` from the detail answer; an answer without it offers nothing.
// - Submit refuses a schedule whose instalment would be 0.00 with 422 `PAYMENT_INSTALMENT_ZERO`,
//   `details: { label, total }`.
// - The evidence of an accepted version is `GET .../versions/:vid/evidence` (`QuotationEvidenceDto`; 404
//   when there is no acceptance or it is out of scope). A portal acceptance is `pending` until a staff member
//   confirms it with `POST .../evidence-confirmation` (`ConfirmEvidenceBody`, Idempotency-Key).
import {
  canCancelQuotation,
  type EvidenceKind,
  type EvidencePolicy,
  type QuotationCapabilities,
  type QuotationEvidenceDto,
  type QuotationStatus,
} from '@bos/contracts';

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

/** The API codes for "an instalment would round to 0.00" on submit (FR-4). */
export const ZERO_INSTALMENT_CODES: readonly string[] = ['PAYMENT_INSTALMENT_ZERO'];

/** Also recognised by its words, in case the code differs: "instalment" (or "installment") and "0.00". */
const ZERO_INSTALMENT_WORDS = /instal{1,2}ment[\s\S]*\b0\.00\b|\b0\.00\b[\s\S]*instal{1,2}ment/i;

export function isZeroInstalmentRefusal(code: string, message: string): boolean {
  return ZERO_INSTALMENT_CODES.includes(code) || ZERO_INSTALMENT_WORDS.test(message);
}

export const ZERO_INSTALMENT_MESSAGE =
  'At least one payment milestone would come to 0.00 at this total. Remove that milestone or raise its share, then submit again. Nothing was submitted.';

/**
 * Cancel quotation is offered on a Draft, Returned or Submitted version only when the API says this caller
 * may cancel it (`capabilities.canCancel`). An answer without the field offers nothing.
 */
export function mayCancel(
  status: QuotationStatus,
  capabilities: Pick<QuotationCapabilities, 'canCancel'>,
): boolean {
  return canCancelQuotation(status) && capabilities.canCancel === true;
}

// ---- Acceptance evidence (F1-Q28) ------------------------------------------------------------

export type QuotationEvidence = QuotationEvidenceDto;

/** The kinds the company's evidence policy asks for: `both` is a contract and a purchase order. */
export function policyKinds(policy: EvidencePolicy): EvidenceKind[] {
  return policy === 'both' ? ['contract', 'purchase_order'] : [policy];
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
