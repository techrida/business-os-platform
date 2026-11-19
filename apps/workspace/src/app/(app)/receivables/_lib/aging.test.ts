import { AGING_BUCKETS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { BUCKET_CARD, BUCKET_LABEL, isZeroAmount } from './aging';

describe('aging helpers', () => {
  it('words every contract bucket, in contract order', () => {
    expect(Object.keys(BUCKET_LABEL)).toEqual([...AGING_BUCKETS]);
    for (const b of AGING_BUCKETS) expect(BUCKET_LABEL[b]).not.toBe('');
  });

  it('gives every contract bucket a card look, more urgent as the money gets older', () => {
    expect(Object.keys(BUCKET_CARD)).toEqual([...AGING_BUCKETS]);
    expect(AGING_BUCKETS.map((b) => BUCKET_CARD[b].tone)).toEqual([
      'success',
      'warning',
      'warning',
      'error',
      'error',
    ]);
  });

  it('recognises a zero amount from its text, without turning it into a number', () => {
    expect(isZeroAmount('0')).toBe(true);
    expect(isZeroAmount('0.00')).toBe(true);
    expect(isZeroAmount('-0.00')).toBe(true);
    expect(isZeroAmount('0.01')).toBe(false);
    expect(isZeroAmount('10.00')).toBe(false);
    expect(isZeroAmount('100')).toBe(false);
    expect(isZeroAmount('')).toBe(false);
  });
});
