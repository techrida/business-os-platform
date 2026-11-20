// How a PDF render that fails is retried (round 4, R4c2: TR-Q4 and F1-Q13). One policy for the quotation, invoice and
// purchase-order render sweepers, so the screens can promise the same thing everywhere: a PDF that is being prepared
// is either ready, or still being tried in the background, or given up with a Retry.
//
// A failed render is tried again after a pause that doubles each time (1, 2, 4 minutes), MAX_RENDER_ATTEMPTS tries in
// all. The sweepers tick once a minute, so a render that never works is given up roughly 8 to 10 minutes after the
// first try; the screens keep polling for longer than that (RENDER_GIVE_UP_WITHIN_MS), so they always see the outcome.
// Giving up writes one admin (audit) entry for the document, in the same transaction as the state change, so two
// workers that race on the last failure write it once. Retry (staff) starts a fresh set of tries.

import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';

/** Tries in all, the first render included, before the render is given up. */
export const MAX_RENDER_ATTEMPTS = 4;
/** The pause after the first failure; it doubles after each further failure, up to RETRY_PAUSE_MAX_MS. */
export const RETRY_PAUSE_BASE_MS = 60_000;
export const RETRY_PAUSE_MAX_MS = 30 * 60_000;
/**
 * An upper bound on how long after the first try a render is given up: every pause, plus one sweep tick and one render
 * deadline per try. It is the contracts' PDF_PREPARE_WITHIN_MS, how long the screens poll a PDF that is being
 * prepared; render-retry.test.ts checks this policy fits in it. A backlog of more than one batch, or a quotation claim
 * left by a worker that died (taken again after 10 minutes, not counted as a try), can take longer: the screens then
 * offer "Check again".
 */
export const RENDER_GIVE_UP_WITHIN_MS = PDF_PREPARE_WITHIN_MS;

/**
 * When the invoice and purchase-order sweepers treat a generated document that never got its bytes as left by a render
 * that crashed midway, and soft-remove it so its owner is rendered again. While it is live the screens show "Preparing
 * PDF", so a crash on the first try must be recovered within PDF_PREPARE_WITHIN_MS: first try, this wait, the sweep
 * that removes it and the next try fit in it (render-retry.test.ts). It is far above the legitimate gap it must not
 * cut short: the document is created after Chromium finished, so only storing and hashing the bytes are in between.
 * 10 minutes, like a quotation's stale render claim. (Quotation documents do not block a render, so they keep an hour.)
 */
export const GENERATED_ORPHAN_AFTER_MS = 10 * 60_000;

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

/**
 * A quotation version's render was given up: `failed` on its last try. The sweeper does not take it again until a
 * Retry. Quotation versions keep their tries on the row (render_attempts, 0115).
 */
export function quotationRenderGivenUp(v: {
  renderState: string;
  renderAttempts: number;
}): boolean {
  return v.renderState === 'failed' && v.renderAttempts >= MAX_RENDER_ATTEMPTS;
}

/** The audit action the sweepers write when a document's render is given up, by document kind. */
export const RENDER_GIVEN_UP_ACTION = {
  quotation: 'quotation.pdf_render_failed',
  invoice: 'invoice.pdf_render_failed',
  purchase_order: 'purchase_order.pdf_render_failed',
} as const;
