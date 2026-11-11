import { describe, expect, it } from 'vitest';

import { describePaymentFailure } from './failure';

const err = (status: number, body?: unknown) => ({ status, body });
const coded = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  err(status, { error: { code, message: 'x', correlationId: 'c', ...extra } });

describe('describePaymentFailure', () => {
  it('says plainly that the person who recorded a payment cannot verify it', () => {
    const f = describePaymentFailure(coded(403, 'forbidden', { reason: 'separation_of_duties' }));
    expect(f.kind).toBe('self_verification');
    expect(f.message).toMatch(/you recorded this payment/i);
    expect(f.message).toMatch(/someone else/i);
    expect(f.definite).toBe(true);
  });

  it('words an ordinary 403 and a missing role differently from a separation refusal', () => {
    expect(describePaymentFailure(err(403)).message).toMatch(/permission/i);
    expect(
      describePaymentFailure(coded(403, 'forbidden', { reason: 'no_permission' })).message,
    ).toMatch(/roles/i);
  });

  it('names OVER_ALLOCATION and MISMATCHED_ITEMS instead of asking for a reload', () => {
    const over = describePaymentFailure(coded(409, 'OVER_ALLOCATION'));
    expect(over.kind).toBe('over_allocation');
    expect(over.reload).toBe(false);
    expect(over.message).toMatch(/nothing was allocated/i);
    const mismatch = describePaymentFailure(coded(422, 'MISMATCHED_ITEMS'));
    expect(mismatch.kind).toBe('mismatched_items');
    expect(mismatch.reload).toBe(false);
    expect(mismatch.message).toMatch(/customer or currency/i);
  });

  it('treats the in-progress idempotency 409 as not definite so the same key is sent again', () => {
    const f = describePaymentFailure(
      err(409, {
        error: {
          code: 'conflict',
          message: 'A request with this Idempotency-Key is still in progress',
          correlationId: 'c',
        },
      }),
    );
    expect(f.kind).toBe('in_progress');
    expect(f.definite).toBe(false);
    expect(f.reload).toBe(false);
  });

  it('treats any other 409 as a stale version and asks for a reload', () => {
    const f = describePaymentFailure(coded(409, 'conflict'));
    expect(f.kind).toBe('stale');
    expect(f.reload).toBe(true);
    expect(f.definite).toBe(true);
  });

  it('is definite for 4xx and not for timeouts, 5xx and network failures', () => {
    expect(describePaymentFailure(err(422)).definite).toBe(true);
    expect(describePaymentFailure(err(404)).kind).toBe('not_found');
    expect(describePaymentFailure(err(401)).kind).toBe('session');
    expect(describePaymentFailure(err(500)).definite).toBe(false);
    expect(describePaymentFailure(err(408)).definite).toBe(false);
    expect(describePaymentFailure(err(429)).definite).toBe(false);
    const network = describePaymentFailure(new Error('fetch failed'));
    expect(network.kind).toBe('unavailable');
    expect(network.definite).toBe(false);
    expect(network.message).toMatch(/will not be applied twice/i);
  });

  it('shows the API text only for a 400', () => {
    expect(
      describePaymentFailure(
        err(400, {
          error: { code: 'validation', message: 'reason is required', correlationId: 'c' },
        }),
      ).message,
    ).toContain('reason is required');
    expect(
      describePaymentFailure(
        err(422, { error: { code: 'x', message: 'secret detail', correlationId: 'c' } }),
      ).message,
    ).not.toContain('secret detail');
  });
});
