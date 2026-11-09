import { PAYMENT_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_STATUS_OPTIONS,
  actionsFor,
  methodLabel,
  parseStatusFilter,
  paymentStatusMeta,
} from './status';

describe('payment status', () => {
  it('has a label and a tone for every contract status, in contract order', () => {
    expect(PAYMENT_STATUS_OPTIONS.map((o) => o.value)).toEqual([...PAYMENT_STATUSES]);
    for (const s of PAYMENT_STATUSES) expect(paymentStatusMeta(s).label).not.toBe('');
  });

  it('accepts only an exact contract status as a filter', () => {
    expect(parseStatusFilter('verified')).toBe('verified');
    expect(parseStatusFilter('Verified')).toBeUndefined();
    expect(parseStatusFilter('toString')).toBeUndefined();
    expect(parseStatusFilter(['verified', 'rejected'])).toBeUndefined();
    expect(parseStatusFilter('')).toBeUndefined();
    expect(parseStatusFilter(undefined)).toBeUndefined();
  });

  it('offers actions by status: verify or reject while submitted, reverse once verified', () => {
    expect(actionsFor('submitted')).toEqual({ verify: true, reject: true, reverse: false });
    expect(actionsFor('verified')).toEqual({ verify: false, reject: false, reverse: true });
    for (const s of ['rejected', 'withdrawn', 'reversed'] as const) {
      expect(actionsFor(s)).toEqual({ verify: false, reject: false, reverse: false });
    }
  });

  it('labels methods and falls back to the raw text for an unknown one', () => {
    expect(methodLabel('bank_transfer')).toBe('Bank transfer');
    expect(methodLabel('cheque')).toBe('Cheque');
    expect(methodLabel('crypto')).toBe('crypto');
  });
});
