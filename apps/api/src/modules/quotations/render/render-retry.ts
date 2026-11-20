// How a PDF render that fails is retried (round 4, R4c2: TR-Q4 and F1-Q13). One policy for the quotation, invoice and
// purchase-order render sweepers, so the screens can promise the same thing everywhere: a PDF that is being prepared
// is either ready, or still being tried in the background, or given up with a Retry.
//
// A failed render is tried again after a pause that doubles each time (1, 2, 4 minutes), MAX_RENDER_ATTEMPTS tries in
// all. The sweepers tick once a minute, so a render that never works is given up roughly 8 to 10 minutes after the
// first try; the screens keep polling for longer than that (RENDER_GIVE_UP_WITHIN_MS), so they always see the outcome.
// Giving up writes one admin (audit) entry for the document, in the same transaction as the state change, so two
// workers that race on the last failure write it once. Retry (staff) starts a fresh set of tries.

/** Tries in all, the first render included, before the render is given up. */
export const MAX_RENDER_ATTEMPTS = 4;
/** The pause after the first failure; it doubles after each further failure, up to RETRY_PAUSE_MAX_MS. */
export const RETRY_PAUSE_BASE_MS = 60_000;
export const RETRY_PAUSE_MAX_MS = 30 * 60_000;
/**
 * An upper bound on how long after the first try a render is given up: every pause, plus one sweep tick and one render
 * deadline per try. Tests check the screens poll at least this long.
 */
export const RENDER_GIVE_UP_WITHIN_MS = 15 * 60_000;

/**
 * The pause before the next try, after `failures` failed tries in a row (1 or more). Null once the tries are used up:
 * the render is given up.
 */
export function nextRetryPauseMs(failures: number): number | null {
  if (!Number.isInteger(failures) || failures < 1)
    throw new RangeError(`not a failure count: ${failures}`);
  if (failures >= MAX_RENDER_ATTEMPTS) return null;
  return Math.min(RETRY_PAUSE_BASE_MS * 2 ** (failures - 1), RETRY_PAUSE_MAX_MS);
}

/** The audit action the sweepers write when a document's render is given up, by document kind. */
export const RENDER_GIVEN_UP_ACTION = {
  quotation: 'quotation.pdf_render_failed',
  invoice: 'invoice.pdf_render_failed',
  purchase_order: 'purchase_order.pdf_render_failed',
} as const;
