// The backoff for a new picture that answers 404 until its virus scan is done. Shared by ImageUpload (which polls the
// scan) and Avatar (which asks again for a picture that failed), so both give up at the same time. Kept apart from
// both because image-upload.tsx already imports avatar.tsx.

/** First wait before asking whether a new picture has passed its scan. */
export const SCAN_POLL_FIRST_MS = 1_000;
/** The longest single wait between two asks. */
export const SCAN_POLL_CAP_MS = 15_000;
/** After this long the asking stops and the initials stay in place; a later page load shows the picture. */
export const SCAN_POLL_BUDGET_MS = 60_000;

/**
 * The waits between scan checks: doubling from `firstMs`, each at most `capMs`, and adding up to no more than
 * `budgetMs`. The defaults give 1, 2, 4, 8, 15, 15 and 15 seconds: seven checks in exactly one minute.
 */
export function scanPollDelays(
  budgetMs: number = SCAN_POLL_BUDGET_MS,
  firstMs: number = SCAN_POLL_FIRST_MS,
  capMs: number = SCAN_POLL_CAP_MS,
): number[] {
  if (!(firstMs > 0) || !(capMs > 0) || !(budgetMs > 0)) return [];
  const delays: number[] = [];
  let total = 0;
  let next = firstMs;
  for (;;) {
    const delay = Math.min(next, capMs);
    if (total + delay > budgetMs) break;
    delays.push(delay);
    total += delay;
    next *= 2;
  }
  return delays;
}
