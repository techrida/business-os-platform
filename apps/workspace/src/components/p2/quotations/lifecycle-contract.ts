// The quotation lifecycle API this screen expects from the parallel API work (round 4): Cancel quotation,
// staff confirmation of acceptance evidence, and the refusal of a schedule with a 0.00 instalment. Every
// path, field name and error code the workspace assumes about that work lives in this one file, so the
// wiring is adjusted here once the API lands. Pure (no server-only import): the page, the server actions
// and the tests all read it.
//
// Cancel and the zero-instalment refusal follow the API as built (round 4, unit A):
// - Cancel is `POST /v1/quotations/:id/cancel` with an Idempotency-Key and `{ reason, expectedVersion }`,
//   where `expectedVersion` is the current version row's `version`, the same guard Revise uses. Allowed
//   on a Draft, Returned or Submitted version; cancelling a Submitted one also cancels its open approval
//   request. The detail answer's optional `capabilities.canCancel` decides the button; absent means no.
// - Submit refuses a schedule whose instalment would be 0.00 with 422 `PAYMENT_INSTALMENT_ZERO`,
//   `details: { label, total }`.
// Still assumed, until the acceptance work lands:
// - The detail answer may carry `capabilities.canConfirmAcceptance`; when absent, the live
//   `quotation.record_acceptance` grant stands in.
// - An accepted version may carry `acceptanceConfirmation: { status: 'awaiting' | 'confirmed',
//   confirmedAt, confirmedByUserId }`. Absent means the API has no confirmation step yet, and the screen
//   shows nothing about it.
// - Confirming is `POST /v1/quotations/:id/versions/:vid/acceptance/confirm` with `{ expectedVersion }`.
import type { QuotationDetail, QuotationStatus } from '@bos/contracts';
import { z } from 'zod';

const q = (id: string): string => `/v1/quotations/${encodeURIComponent(id)}`;
const v = (quotationId: string, versionId: string): string =>
  `${q(quotationId)}/versions/${encodeURIComponent(versionId)}`;

export const lifecyclePaths = {
  cancel: (quotationId: string): string => `${q(quotationId)}/cancel`,
  confirmAcceptance: (quotationId: string, versionId: string): string =>
    `${v(quotationId, versionId)}/acceptance/confirm`,
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

const AcceptanceConfirmationSchema = z.object({
  status: z.enum(['awaiting', 'confirmed']),
  confirmedAt: z.string().nullable().optional(),
  confirmedByUserId: z.string().nullable().optional(),
});
export type AcceptanceConfirmation = z.infer<typeof AcceptanceConfirmationSchema>;

/**
 * The fields of the detail answer that the contract does not describe yet. Lenient: each one is read
 * on its own, and anything malformed reads as absent, so the rest of the page is never affected.
 */
const ExtrasSchema = z.object({
  capabilities: z
    .object({
      canCancel: z.boolean().optional().catch(undefined),
      canConfirmAcceptance: z.boolean().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  versions: z
    .array(
      z.object({
        id: z.string(),
        acceptanceConfirmation: AcceptanceConfirmationSchema.nullable().optional().catch(undefined),
      }),
    )
    .optional()
    .catch(undefined),
});

export interface QuotationLifecycle {
  canCancel?: boolean | undefined;
  canConfirmAcceptance?: boolean | undefined;
  /** By version id; only versions that carry the field. */
  confirmations: Readonly<Record<string, AcceptanceConfirmation | null>>;
}

/** Reads the lifecycle fields from the raw detail body (the contract's parse drops them). */
export function readLifecycle(body: unknown): QuotationLifecycle {
  const parsed = ExtrasSchema.safeParse(body);
  if (!parsed.success) return { confirmations: {} };
  const confirmations: Record<string, AcceptanceConfirmation | null> = {};
  for (const version of parsed.data.versions ?? []) {
    if (version.acceptanceConfirmation !== undefined) {
      confirmations[version.id] = version.acceptanceConfirmation;
    }
  }
  return {
    canCancel: parsed.data.capabilities?.canCancel,
    canConfirmAcceptance: parsed.data.capabilities?.canConfirmAcceptance,
    confirmations,
  };
}

/** The detail answer with the lifecycle fields kept beside it. */
export type QuotationDetailWithLifecycle = QuotationDetail & { lifecycle?: QuotationLifecycle };

const NONE: QuotationLifecycle = { confirmations: {} };

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
