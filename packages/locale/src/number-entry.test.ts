import { describe, expect, it } from 'vitest';

import { fitsWhileTyping, normalisePastedNumber, withinLimits } from './number-entry.js';

const MONEY = { intDigits: 16, scale: 2 };
const QTY = { intDigits: 14, scale: 4 };
const WHOLE = { intDigits: 3, scale: 0 };

describe('normalisePastedNumber', () => {
  it.each([
    ['NPR 12,50,000.00', '1250000.00'],
    ['npr 12,50,000.00', '1250000.00'],
    ['Rs. 1,250/-', '1250'],
    ['Rs 1,250 /-', '1250'],
    ['रू 12,50,000', '1250000'],
    ['₹1,250.5', '1250.5'],
    ['USD 1,250,000.50', '1250000.50'],
    ['$1,250,000', '1250000'],
    ['  1250  ', '1250'],
    ['12,50,000.00', '1250000.00'],
    ['1,250,000.50', '1250000.50'],
    ['007', '7'],
    ['.5', '0.5'],
    ['12.', '12'],
    ['0', '0'],
    ['9999999999999999.99', '9999999999999999.99'],
  ])('reads %j as %s', (pasted, plain) => {
    expect(normalisePastedNumber(pasted, MONEY)).toEqual({ ok: true, value: plain });
  });

  it.each([
    ['1,5', 'comma'],
    ['10,50', 'comma'],
    ['12,5,000', 'comma'],
    ['1,000,00', 'comma'],
    ['10 50', 'space'],
    ['1 250 000', 'space'],
    ['NPR 10 50', 'space'],
    ['1.2.3', 'not_a_number'],
    ['-5', 'not_a_number'],
    ['+5', 'not_a_number'],
    ['12abc', 'not_a_number'],
    ['1e5', 'not_a_number'],
    ['१२३', 'not_a_number'],
    ['.', 'not_a_number'],
    ['', 'empty'],
    ['NPR', 'empty'],
    ['   ', 'empty'],
    ['12345678901234567', 'too_many_digits'],
    ['1.234', 'too_many_decimals'],
  ] as const)('refuses %j as %s', (pasted, reason) => {
    const result = normalisePastedNumber(pasted, MONEY);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe(reason);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it('says to use a point for a decimal comma', () => {
    const result = normalisePastedNumber('1,5', MONEY);
    expect(result).toMatchObject({ ok: false, message: 'Use a point for decimals.' });
  });

  it('refuses a decimal for a whole-number field', () => {
    expect(normalisePastedNumber('12.5', WHOLE)).toMatchObject({
      ok: false,
      reason: 'too_many_decimals',
    });
    expect(normalisePastedNumber('1,000', WHOLE)).toMatchObject({
      ok: false,
      reason: 'too_many_digits',
    });
  });

  it('keeps the old value out of it: it only judges the pasted text against max', () => {
    expect(normalisePastedNumber('NPR 21,00,000', MONEY, { max: '2018180' })).toMatchObject({
      ok: false,
      reason: 'above_max',
    });
    expect(normalisePastedNumber('NPR 20,18,180', MONEY, { max: '2018180' })).toEqual({
      ok: true,
      value: '2018180',
    });
  });
});

describe('withinLimits', () => {
  it('normalises leading zeros and a bare point', () => {
    expect(withinLimits('0001250.50', MONEY)).toEqual({ ok: true, value: '1250.50' });
    expect(withinLimits('.25', QTY)).toEqual({ ok: true, value: '0.25' });
  });

  it('compares min and max exactly, past 2^53', () => {
    const big = '9007199254740993.00';
    expect(withinLimits(big, MONEY, { max: '9007199254740992.00' })).toMatchObject({
      reason: 'above_max',
    });
    expect(withinLimits(big, MONEY, { max: big })).toMatchObject({ ok: true });
    expect(withinLimits('0.10', MONEY, { min: '0.11' })).toMatchObject({ reason: 'below_min' });
    expect(withinLimits('0.10', MONEY, { min: '0.1' })).toMatchObject({ ok: true });
  });

  it('treats an empty bound as no bound', () => {
    expect(withinLimits('5', MONEY, { min: '', max: '' })).toMatchObject({ ok: true });
  });

  it('refuses the empty string and a bare point', () => {
    expect(withinLimits('', MONEY)).toMatchObject({ reason: 'empty' });
    expect(withinLimits('.', MONEY)).toMatchObject({ reason: 'not_a_number' });
  });
});

describe('fitsWhileTyping', () => {
  it.each([
    ['', true],
    ['.', true],
    ['12', true],
    ['12.', true],
    ['12.5', true],
    ['12.50', true],
    ['12.505', false],
    ['1,5', false],
    ['1 5', false],
    ['1.2.3', false],
    ['-1', false],
    ['1e', false],
    ['1234567890123456', true],
    ['12345678901234567', false],
    ['0000000000000000001', true],
  ])('%j with money limits: %s', (text, ok) => {
    expect(fitsWhileTyping(text, MONEY)).toBe(ok);
  });

  it('refuses a point in a whole-number field', () => {
    expect(fitsWhileTyping('1.', WHOLE)).toBe(false);
    expect(fitsWhileTyping('999', WHOLE)).toBe(true);
    expect(fitsWhileTyping('9999', WHOLE)).toBe(false);
  });
});
