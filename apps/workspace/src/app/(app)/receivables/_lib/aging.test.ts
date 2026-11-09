import { AGING_BUCKETS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { BUCKET_LABEL, isZeroAmount } from './aging';

describe('aging helpers', () => {
  it('words every contract bucket, in contract order', () => {
    expect(Object.keys(BUCKET_LABEL)).toEqual([...AGING_BUCKETS]);
    for (const b of AGING_BUCKETS) expect(BUCKET_LABEL[b]).not.toBe('');
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
