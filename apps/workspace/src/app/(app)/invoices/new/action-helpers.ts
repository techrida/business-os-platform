import { randomUUID } from 'node:crypto';

import { describeBillingFailure, keyAfterFailure } from '@/lib/api-billing';

import type { InvoiceFormState } from './form-state';

// Shared by the manual invoice, credit note and debit note actions. Not a Server Actions file, so it
// may export values.

/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

export function textOf(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** The key the form submitted, or a fresh one when it is missing or is not ours. */
export function keyOf(form: FormData): string {
  const submitted = textOf(form, 'idempotencyKey');
  return KEY.test(submitted) ? submitted : randomUUID();
}

export const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

/** A refusal before the API is called: the key is still unused, so the next submit keeps it. */
export const refusal = (key: string, error: string): InvoiceFormState => ({
  key,
  errors: {},
  error,
});

/**
 * The state after a failed call. The key is kept after an unknown outcome (timeout, 5xx) and after
 * the in-progress 409, and rotated after a final answer, by the billing client's `keyAfterFailure`.
 * `words` may replace the message for a refusal the generic wording cannot explain.
 */
export function failureState(
  err: unknown,
  key: string,
  words?: (kind: ReturnType<typeof describeBillingFailure>) => string | undefined,
): InvoiceFormState {
  const failure = describeBillingFailure(err);
  return {
    key: keyAfterFailure(err, key),
    errors: {},
    error: words?.(failure) ?? failure.message,
    ...(failure.reload ? { reload: true } : {}),
  };
}
