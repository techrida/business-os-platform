import { describe, expect, it } from 'vitest';

import {
  DecimalString,
  MONEY_LIMITS,
  NonNegativeDecimalString,
  PERCENT_LIMITS,
  PercentFourDecimals,
  QUANTITY_LIMITS,
  QuantityString,
  RATE_LIMITS,
  RateString,
  decimalPattern,
} from './index.js';

// The patterns are now built from the exported limits. Every fixture below was accepted or refused by the
// hand-written patterns before, so nothing about what the schemas take has changed.
const accepted = (schema: { safeParse: (v: string) => { success: boolean } }, v: string) =>
  schema.safeParse(v).success;

describe('decimalPattern', () => {
  it('builds the same shape the hand-written patterns had', () => {
    expect(decimalPattern(MONEY_LIMITS, { signed: true }).source).toBe(
      '^-?\\d{1,16}(\\.\\d{1,2})?$',
    );
    expect(decimalPattern(RATE_LIMITS).source).toBe('^\\d{1,12}(\\.\\d{1,6})?$');
    expect(decimalPattern(QUANTITY_LIMITS).source).toBe('^\\d{1,14}(\\.\\d{1,4})?$');
    expect(decimalPattern(PERCENT_LIMITS).source).toBe('^\\d{1,3}(\\.\\d{1,4})?$');
  });

  it('leaves out the decimal part for a whole-number limit', () => {
    const whole = decimalPattern({ intDigits: 3, scale: 0 });
    expect(whole.test('999')).toBe(true);
    expect(whole.test('9.5')).toBe(false);
    expect(whole.test('1000')).toBe(false);
  });
});

describe('contract patterns after the refactor', () => {
  it.each([
    [DecimalString, '1', true],
    [DecimalString, '-1250000.5', true],
    [DecimalString, '9999999999999999.99', true],
    [DecimalString, '10000000000000000', false],
    [DecimalString, '1.234', false],
    [DecimalString, '1,5', false],
    [DecimalString, '10 50', false],
    [DecimalString, '.5', false],
    [DecimalString, '1.', false],
    [NonNegativeDecimalString, '-1', false],
    [NonNegativeDecimalString, '0.00', true],
    [RateString, '131.123456', true],
    [RateString, '131.1234567', false],
    [RateString, '1234567890123', false],
    [RateString, '-1', false],
    [QuantityString, '99999999999999.9999', true],
    [QuantityString, '100000000000000', false],
    [QuantityString, '0.0001', true],
    [QuantityString, '0', false],
    [QuantityString, '1.00001', false],
    [PercentFourDecimals, '100', true],
    [PercentFourDecimals, '100.0000', true],
    [PercentFourDecimals, '100.0001', false],
    [PercentFourDecimals, '33.3334', true],
    [PercentFourDecimals, '101', false],
  ] as const)('%#: %s accepts %s -> %s', (schema, value, ok) => {
    expect(accepted(schema, value)).toBe(ok);
  });
});
