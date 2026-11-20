import { z } from 'zod';

/**
 * Why a 403 (or a 400) was refused, so the workspace can show the right message. `inactive_user` is
 * not in the plan's section 6.1 list but is in the section 6.2 `Decision` type, so it is allowed here
 * too. ADR 0027 §4 adds `entity_not_permitted` (403: the caller may not act for that entity, or it is
 * unknown) and `invalid_entity` (400: a malformed `X-Entity-Id` header). `deadline_in_past` (400, P4 sourcing): an
 * RFQ's quotation deadline is not after now, so no invited vendor could ever quote.
 */
export const ERROR_REASONS = [
  'no_permission',
  'out_of_scope',
  'separation_of_duties',
  'mfa_required',
  'inactive_user',
  'entity_not_permitted',
  'invalid_entity',
  'stale_memo',
  'deadline_in_past',
  // F1-Q55 (400): a customer of the same name, or the same PAN/VAT number once spaces and hyphens are dropped,
  // already exists and the create named no `duplicateOverrideReason`.
  'duplicate_reason_required',
] as const;
export const ErrorReasonSchema = z.enum(ERROR_REASONS);
export type ErrorReason = z.infer<typeof ErrorReasonSchema>;

/** Error body returned by every non-2xx API response. */
export const ErrorBodySchema = z.object({
  error: z.object({
    code: z.string().min(1),
    message: z.string(),
    correlationId: z.string().min(1),
    /** Present only for allow-listed reasons. */
    reason: ErrorReasonSchema.optional(),
    /** Facts a client can show next to a domain code such as `fx_rate_stale`: currency, rate date, limit. */
    details: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
  }),
});
export type ErrorBody = z.infer<typeof ErrorBodySchema>;

// ---------------------------------------------------------------------------------------------
// P3 sales and invoicing: domain codes (ErrorBody.code), kept apart from the reasons above so a
// parallel phase's additions merge cleanly. Each code has one fixed HTTP status.
// ---------------------------------------------------------------------------------------------

/**
 * Codes the P3 commands answer with, mapped to their HTTP status. `SCHEDULE_LINE_TAKEN` is a double
 * draft; `OVER_ALLOCATION` and `MISMATCHED_ITEMS` come from the ledger (an allocation above the open
 * amount, or across customers, currencies or sides); `evidence_policy_unmet` blocks a sales order
 * confirm; `fx_rate_stale` blocks issue with a rate older than `fx.max_rate_age_days`; `NOT_APPROVED`
 * and `PERIOD_FY_MISMATCH` refuse an issue; `credit_hold` blocks a sales order confirm while the customer is over its
 * credit limit and the deal has no credit override (F1-Q20/F1-Q26; details name the deal only). `already_issued` is the replay answer of `issue`: the
 * command returns it as a 200 result (`IssueInvoiceResult`), and the code is listed so a client can
 * name it. Facts such as the currency and rate date travel in `ErrorBody.error.details`.
 */
export const BILLING_ERROR_CODES = {
  CREDIT_EXCEEDS_INVOICE: 409,
  SCHEDULE_LINE_TAKEN: 409,
  OVER_ALLOCATION: 409,
  MISMATCHED_ITEMS: 409,
  NOT_APPROVED: 409,
  PERIOD_FY_MISMATCH: 409,
  already_issued: 200,
  fx_rate_stale: 409,
  evidence_policy_unmet: 422,
  credit_hold: 409,
  /** Issue refused: the drafted due date is before today, the issue date. `details` names both when known. */
  DUE_DATE_BEFORE_ISSUE: 422,
} as const;
export type BillingErrorCode = keyof typeof BILLING_ERROR_CODES;
export const BillingErrorCodeSchema = z.enum(
  Object.keys(BILLING_ERROR_CODES) as [BillingErrorCode, ...BillingErrorCode[]],
);
