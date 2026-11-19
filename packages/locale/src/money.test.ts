import { describe, expect, it } from 'vitest';
import { DEFAULT_NUMBER_SYSTEM, Dec, formatMoney, groupDigits } from './money.js';

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

describe('DEFAULT_NUMBER_SYSTEM', () => {
  it('is south_asian', () => {
    expect(DEFAULT_NUMBER_SYSTEM).toBe('south_asian');
  });
});

describe('groupDigits', () => {
  it.each([
    ['0', '0', '0'],
    ['7', '7', '7'],
    ['999', '999', '999'],
    ['1000', '1,000', '1,000'],
    ['12345', '12,345', '12,345'],
    ['99999', '99,999', '99,999'],
    ['100000', '1,00,000', '100,000'],
    ['2018180', '20,18,180', '2,018,180'],
    ['9999999', '99,99,999', '9,999,999'],
    ['10000000', '1,00,00,000', '10,000,000'],
    ['1000000000', '1,00,00,00,000', '1,000,000,000'],
    ['98765432109876543', '98,76,54,32,10,98,76,543', '98,765,432,109,876,543'],
  ])('groups %s', (digits, southAsian, international) => {
    expect(groupDigits(digits, 'south_asian')).toBe(southAsian);
    expect(groupDigits(digits, 'international')).toBe(international);
  });

  it('rejects anything but digits', () => {
    expect(() => groupDigits('-1', 'south_asian')).toThrow(RangeError);
    expect(() => groupDigits('1.5', 'international')).toThrow(RangeError);
    expect(() => groupDigits('', 'south_asian')).toThrow(RangeError);
  });
});

describe('formatMoney numberSystem', () => {
  it('groups every currency in lakhs for south_asian', () => {
    expect(formatMoney('2018180', 'NPR', { numberSystem: 'south_asian' })).toBe('NPR 20,18,180.00');
    expect(formatMoney('2018180', 'INR', { numberSystem: 'south_asian' })).toBe('INR 20,18,180.00');
    expect(formatMoney('2018180', 'USD', { numberSystem: 'south_asian' })).toBe('USD 20,18,180.00');
  });

  it('groups every currency in thousands for international', () => {
    expect(formatMoney('2018180', 'NPR', { numberSystem: 'international' })).toBe(
      'NPR 2,018,180.00',
    );
    expect(formatMoney('2018180', 'INR', { numberSystem: 'international' })).toBe(
      'INR 2,018,180.00',
    );
    expect(formatMoney('2018180', 'USD', { numberSystem: 'international' })).toBe(
      'USD 2,018,180.00',
    );
  });

  it('keeps rounding, signs and symbols', () => {
    expect(formatMoney('-1234567.895', 'NPR', { numberSystem: 'international' })).toBe(
      'NPR -1,234,567.90',
    );
    expect(formatMoney('-1234567.895', 'USD', { numberSystem: 'south_asian', symbol: true })).toBe(
      '-$12,34,567.90',
    );
    expect(formatMoney('-0.004', 'NPR', { numberSystem: 'south_asian' })).toBe('NPR 0.00');
    expect(formatMoney('999999.995', 'NPR', { numberSystem: 'south_asian' })).toBe(
      'NPR 10,00,000.00',
    );
    expect(formatMoney('999999.995', 'NPR', { numberSystem: 'international' })).toBe(
      'NPR 1,000,000.00',
    );
  });

  it('stays exact above 2^53', () => {
    expect(formatMoney('98765432109876543.21', 'USD', { numberSystem: 'south_asian' })).toBe(
      'USD 98,76,54,32,10,98,76,543.21',
    );
    expect(formatMoney('98765432109876543.21', 'NPR', { numberSystem: 'international' })).toBe(
      'NPR 98,765,432,109,876,543.21',
    );
  });

  it('matches the Intl-based default when the system equals the currency default', () => {
    for (const amount of [
      '0',
      '1',
      '999.99',
      '1000',
      '99999.5',
      '100000',
      '12345678.9',
      '98765432109876543.21',
    ]) {
      expect(formatMoney(amount, 'NPR', { numberSystem: 'south_asian' })).toBe(
        formatMoney(amount, 'NPR'),
      );
      expect(formatMoney(amount, 'INR', { numberSystem: 'south_asian' })).toBe(
        formatMoney(amount, 'INR'),
      );
      expect(formatMoney(amount, 'USD', { numberSystem: 'international' })).toBe(
        formatMoney(amount, 'USD'),
      );
    }
  });

  it('is unchanged without the option', () => {
    expect(formatMoney('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(formatMoney('2018180', 'INR')).toBe('INR 20,18,180.00');
    expect(formatMoney('2018180', 'USD')).toBe('USD 2,018,180.00');
    expect(formatMoney('2018180', 'USD', { symbol: true })).toBe('$2,018,180.00');
    expect(formatMoney('2018180', 'NPR', {})).toBe('NPR 20,18,180.00');
  });
});
