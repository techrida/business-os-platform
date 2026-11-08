import { describe, expect, it } from 'vitest';

import {
  DISCOUNT_APPROVAL_THRESHOLD_PCT,
  effectiveDiscountPct,
  exceedsDiscountThreshold,
} from './discount.js';
import { Dec } from './money.js';

const d = (text: string) => new Dec(text);

describe('effectiveDiscountPct', () => {
  it('is discount / subtotal x 100, stored to 4 decimals half up', () => {
    expect(effectiveDiscountPct(d('94000.00'), d('1880000.00'))).toBe('5.0000');
    expect(effectiveDiscountPct(d('208000.00'), d('2599999.99'))).toBe('8.0000');
    expect(effectiveDiscountPct(d('1'), d('3'))).toBe('33.3333');
    expect(effectiveDiscountPct(d('2'), d('3'))).toBe('66.6667');
  });

  it('is 0.0000 when there is nothing to discount', () => {
    expect(effectiveDiscountPct(d('0'), d('0'))).toBe('0.0000');
  });

  it('rejects a discount below zero or above the subtotal', () => {
    expect(() => effectiveDiscountPct(d('-0.01'), d('100'))).toThrow(RangeError);
    expect(() => effectiveDiscountPct(d('100.01'), d('100'))).toThrow(RangeError);
    expect(() => effectiveDiscountPct(d('1'), d('0'))).toThrow(RangeError);
  });
});

describe('exceedsDiscountThreshold (strict > 12, on the unrounded percentage)', () => {
  it('exposes the documented threshold', () => {
    expect(DISCOUNT_APPROVAL_THRESHOLD_PCT).toBe('12');
  });

  it('exactly 12% does not trigger approval, anything above does', () => {
    expect(exceedsDiscountThreshold(d('12000.00'), d('100000.00'))).toBe(false);
    expect(exceedsDiscountThreshold(d('12000.01'), d('100000.00'))).toBe(true);
    expect(exceedsDiscountThreshold(d('11999.99'), d('100000.00'))).toBe(false);
  });

  it('matches the P2 done check: 12.0000% adds no Management step, 12.0001% does', () => {
    expect(exceedsDiscountThreshold(d('12000.00'), d('100000.00'))).toBe(false);
    expect(exceedsDiscountThreshold(d('12000.10'), d('100000.00'))).toBe(true);
  });

  it('compares before rounding: a stored 12.0000 can still be above 12', () => {
    // 12,000.01 / 100,000.00 = 12.00001%: the stored 4dp text is "12.0000" but the rule fires.
    expect(effectiveDiscountPct(d('12000.01'), d('100000.00'))).toBe('12.0000');
    expect(exceedsDiscountThreshold(d('12000.01'), d('100000.00'))).toBe(true);
    // The mirror image: 11.99999..% stores as "12.0000" and must not fire.
    expect(effectiveDiscountPct(d('11999.999'), d('100000.00'))).toBe('12.0000');
    expect(exceedsDiscountThreshold(d('11999.999'), d('100000.00'))).toBe(false);
  });

  it('never divides: a repeating ratio just above 12% still triggers', () => {
    // 12% of 99,999.99 is 11,999.9988; a discount of 12,000.00 is 12.0000120001...%.
    expect(exceedsDiscountThreshold(d('12000.00'), d('99999.99'))).toBe(true);
    expect(exceedsDiscountThreshold(d('11999.99'), d('99999.99'))).toBe(false);
  });

  it('accepts another threshold as text, still strict', () => {
    expect(exceedsDiscountThreshold(d('5.00'), d('100.00'), '5')).toBe(false);
    expect(exceedsDiscountThreshold(d('5.01'), d('100.00'), '5')).toBe(true);
  });

  it('is false when the subtotal is zero', () => {
    expect(exceedsDiscountThreshold(d('0'), d('0'))).toBe(false);
  });
});
