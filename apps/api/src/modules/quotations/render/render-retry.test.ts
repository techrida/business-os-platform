import { PDF_PREPARE_WITHIN_MS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  ORPHAN_AFTER_MS as INVOICE_ORPHAN_AFTER_MS,
  SWEEP_EVERY_MS,
} from '../../invoices/render/invoice-render.sweeper';
import { ORPHAN_AFTER_MS as PO_ORPHAN_AFTER_MS } from '../../procurement/orders/render/purchase-order-render.sweeper';
import {
  MAX_RENDER_ATTEMPTS,
  nextRetryPauseMs,
  RENDER_GIVE_UP_WITHIN_MS,
  RETRY_PAUSE_BASE_MS,
} from './render-retry';

/** One sweep tick plus the Gotenberg deadline the worker's config allows by default, per try. */
const TICK_AND_DEADLINE_MS = 60_000 + 60_000;

describe('nextRetryPauseMs', () => {
  it('doubles the pause after each failure and gives up at the limit', () => {
    expect(nextRetryPauseMs(1)).toBe(RETRY_PAUSE_BASE_MS);
    expect(nextRetryPauseMs(2)).toBe(2 * RETRY_PAUSE_BASE_MS);
    expect(nextRetryPauseMs(3)).toBe(4 * RETRY_PAUSE_BASE_MS);
    expect(nextRetryPauseMs(MAX_RENDER_ATTEMPTS)).toBeNull();
    expect(nextRetryPauseMs(MAX_RENDER_ATTEMPTS + 3)).toBeNull();
  });

  it('refuses a count that is not a failure', () => {
    expect(() => nextRetryPauseMs(0)).toThrow(RangeError);
    expect(() => nextRetryPauseMs(1.5)).toThrow(RangeError);
  });

  it('gives up within the bound the screens poll for', () => {
    let total = 0;
    for (let n = 1; n < MAX_RENDER_ATTEMPTS; n += 1) total += nextRetryPauseMs(n) ?? 0;
    total += MAX_RENDER_ATTEMPTS * TICK_AND_DEADLINE_MS;
    expect(total).toBeLessThanOrEqual(RENDER_GIVE_UP_WITHIN_MS);
  });

  it('recovers an invoice or PO render that crashed midway within the bound the screens poll for', () => {
    // The crashed first try, the orphan wait, the sweep that removes the orphan, and the try after it.
    for (const orphanAfter of [INVOICE_ORPHAN_AFTER_MS, PO_ORPHAN_AFTER_MS]) {
      const total = TICK_AND_DEADLINE_MS + orphanAfter + SWEEP_EVERY_MS + TICK_AND_DEADLINE_MS;
      expect(total).toBeLessThanOrEqual(PDF_PREPARE_WITHIN_MS);
      // Far above the create-to-receive gap (storing and hashing the bytes) it must not cut short.
      expect(orphanAfter).toBeGreaterThanOrEqual(5 * 60_000);
    }
  });
});
