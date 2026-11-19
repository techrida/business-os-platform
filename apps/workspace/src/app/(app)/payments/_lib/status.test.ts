import { PAYMENT_METHODS, PAYMENT_STATUSES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  PAYMENT_METHOD_OPTIONS,
  PAYMENT_STATUS_OPTIONS,
  actionsFor,
  methodLabel,
  paymentStatusMeta,
} from './status';

describe('payment status', () => {
  it('has a label and a tone for every contract status, in contract order', () => {
    expect(PAYMENT_STATUS_OPTIONS.map((o) => o.value)).toEqual([...PAYMENT_STATUSES]);
    for (const s of PAYMENT_STATUSES) expect(paymentStatusMeta(s).label).not.toBe('');
  });

  it('offers every contract method as a filter option, worded', () => {
    expect(PAYMENT_METHOD_OPTIONS.map((o) => o.value)).toEqual([...PAYMENT_METHODS]);
    expect(PAYMENT_METHOD_OPTIONS.find((o) => o.value === 'qr')?.label).toBe('QR payment');
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
