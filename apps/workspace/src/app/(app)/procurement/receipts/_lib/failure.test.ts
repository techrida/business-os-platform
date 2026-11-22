import { describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';

vi.mock('server-only', () => ({}));

import { receiptFailure } from './failure';

const apiError = (status: number, code: string, extra: Record<string, unknown> = {}) =>
  new ApiError(status, 'x', {
    error: { code, message: 'internal wording', correlationId: 'corr-12345678', ...extra },
  });

describe('422 refusals', () => {
  it.each([
    ['over_receipt', /more was entered than is still open/i, true],
    ['po_line_unknown', /no longer on the purchase order/i, true],
    ['duplicate_po_line', /appears twice/i, false],
    ['receipt_kind_mismatch', /goods receipt takes only goods/i, false],
    ['serials_required', /whole units and exactly one serial/i, false],
    ['serials_not_allowed', /does not track serial numbers/i, false],
    ['serial_duplicate', /there twice, or is already/i, false],
  ])('words %s, reload %s', (code, words, reload) => {
    const f = receiptFailure(apiError(422, code), 'create', 'goods');
    expect(f.message).toMatch(words);
    expect(f.message).not.toMatch(/internal wording/);
    expect(f.reload).toBe(reload);
    expect(f.definite).toBe(true);
  });

  it('tells the receiver to ask Procurement to amend the order to receive more (F1-Q39)', () => {
    expect(receiptFailure(apiError(422, 'over_receipt'), 'create', 'goods').message).toMatch(
      /ask Procurement to amend the purchase order first/,
    );
    expect(receiptFailure(apiError(409, 'invalid_transition'), 'create', 'goods').message).toMatch(
      /ask Procurement to amend the purchase order first/,
    );
  });

  it('says a future receipt date is refused', () => {
    expect(receiptFailure(apiError(422, 'RECEIPT_DATE_IN_FUTURE'), 'create').message).toMatch(
      /receipt date is after today/i,
    );
  });

  it('falls back to a plain sentence for a 422 nobody named', () => {
    expect(receiptFailure(apiError(422, 'new_code'), 'create').message).toMatch(/did not accept/i);
  });
});

describe('403 words follow the kind', () => {
  it('sends goods to the warehouse and a service to the requester or the warehouse', () => {
    expect(receiptFailure(apiError(403, 'forbidden'), 'confirm', 'goods').message).toMatch(
      /for the warehouse/i,
    );
    expect(receiptFailure(apiError(403, 'forbidden'), 'confirm', 'service').message).toMatch(
      /raised the purchase request/i,
    );
    expect(receiptFailure(apiError(403, 'forbidden'), 'load').message).toMatch(
      /do not include receipts/i,
    );
  });

  it('names separation of duties and scope in their own words', () => {
    expect(
      receiptFailure(apiError(403, 'forbidden', { reason: 'out_of_scope' }), 'load').message,
    ).toMatch(/area you cannot access/i);
  });
});

describe('409 and the key rule', () => {
  it('words a moved receipt per action and offers a reload', () => {
    const confirm = receiptFailure(apiError(409, 'invalid_transition'), 'confirm');
    expect(confirm.message).toMatch(/can no longer be confirmed/i);
    expect(confirm.reload).toBe(true);
    expect(receiptFailure(apiError(409, 'invalid_transition'), 'reverse').message).toMatch(
      /cannot be reversed/i,
    );
    expect(receiptFailure(apiError(409, 'invalid_transition'), 'create').message).toMatch(
      /not open for receiving/i,
    );
  });

  it('is definite for a 4xx, and not for the in-progress 409, a 5xx, a 408 or a lost connection', () => {
    expect(receiptFailure(apiError(404, 'not_found'), 'confirm').definite).toBe(true);
    expect(receiptFailure(apiError(409, 'invalid_transition'), 'confirm').definite).toBe(true);
    for (const e of [
      apiError(503, 'x'),
      apiError(408, 'x'),
      apiError(409, 'conflict', { message: 'A request with this Idempotency-Key is in progress' }),
      new Error('socket hang up'),
    ]) {
      expect(receiptFailure(e, 'create').definite).toBe(false);
    }
  });
});
