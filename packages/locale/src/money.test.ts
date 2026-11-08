import { describe, expect, it } from 'vitest';
import { Dec, formatMoney } from './money.js';

describe('Dec', () => {
  it('adds without float drift', () => {
    expect(new Dec(0.1).plus(0.2).toString()).toBe('0.3');
    expect(new Dec('0.1').plus('0.2').toString()).toBe('0.3');
  });

  it('rounds half up, including negatives away from zero', () => {
    expect(new Dec('2.5').toDecimalPlaces(0).toString()).toBe('3');
    expect(new Dec('-2.5').toDecimalPlaces(0).toString()).toBe('-3');
  });
});

describe('formatMoney', () => {
  it('groups NPR in lakhs', () => {
    expect(formatMoney('1250000.00', 'NPR')).toBe('NPR 12,50,000.00');
  });

  it('groups INR in lakhs and crores', () => {
    expect(formatMoney('1250000', 'INR')).toBe('INR 12,50,000.00');
    expect(formatMoney('123456789.5', 'INR')).toBe('INR 12,34,56,789.50');
  });

  it('groups USD the western way', () => {
    expect(formatMoney('1250000.00', 'USD')).toBe('USD 1,250,000.00');
  });

  it('stays exact above 2^53', () => {
    expect(formatMoney('98765432109876543.21', 'NPR')).toBe('NPR 98,76,54,32,10,98,76,543.21');
    expect(formatMoney('98765432109876543.21', 'USD')).toBe('USD 98,765,432,109,876,543.21');
  });

  it('formats negatives', () => {
    expect(formatMoney('-1234.5', 'NPR')).toBe('NPR -1,234.50');
    expect(formatMoney('-1234.5', 'NPR', { symbol: true })).toBe('-रू1,234.50');
  });

  it('rounds half up to 2 places', () => {
    expect(formatMoney('0.005', 'NPR')).toBe('NPR 0.01');
    expect(formatMoney('0.004', 'NPR')).toBe('NPR 0.00');
    expect(formatMoney('1.995', 'USD')).toBe('USD 2.00');
  });

  it('never shows negative zero', () => {
    expect(formatMoney('-0', 'NPR')).toBe('NPR 0.00');
    expect(formatMoney('-0.004', 'NPR')).toBe('NPR 0.00');
    expect(formatMoney('-0.004', 'USD', { symbol: true })).toBe('$0.00');
  });

  it('uses currency symbols on request', () => {
    expect(formatMoney('1250000', 'INR', { symbol: true })).toBe('₹12,50,000.00');
    expect(formatMoney('1250000', 'USD', { symbol: true })).toBe('$1,250,000.00');
  });

  it('rejects input that is not a finite decimal', () => {
    expect(() => formatMoney('abc', 'NPR')).toThrow();
    expect(() => formatMoney('Infinity', 'NPR')).toThrow(RangeError);
  });
});
