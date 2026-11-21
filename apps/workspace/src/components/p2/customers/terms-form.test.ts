// The credit limit the Commercial terms card sends: NPR, at most two decimals, never negative; "No limit" is null,
// and an empty amount is an error, never null or 0.00 (zero is a real limit).
import { describe, expect, it } from 'vitest';

import {
  INCOMPLETE,
  LIMIT_INVALID,
  LIMIT_REQUIRED,
  parseCreditLimit,
  sameLimit,
  staleMessage,
} from './terms-form';

describe('parseCreditLimit', () => {
  it('reads No limit as null, whatever was typed', () => {
    expect(parseCreditLimit('none', '')).toEqual({ ok: true, value: null });
    expect(parseCreditLimit('none', '5000')).toEqual({ ok: true, value: null });
  });

  it('keeps a zero limit as a real limit', () => {
    expect(parseCreditLimit('limit', '0.00')).toEqual({ ok: true, value: '0.00' });
    expect(parseCreditLimit('limit', '0')).toEqual({ ok: true, value: '0' });
  });

  it('accepts lakh grouping and outer spaces, and sends plain digits', () => {
    expect(parseCreditLimit('limit', '1,00,000.00')).toEqual({ ok: true, value: '100000.00' });
    expect(parseCreditLimit('limit', ' 250000.5 ')).toEqual({ ok: true, value: '250000.5' });
  });

  it.each(['2 50 000.5', '10 50', '1 250'])(
    'refuses %s: a space inside a number is not grouping, and joining it would be a silent error',
    (typed) => {
      expect(parseCreditLimit('limit', typed).ok).toBe(false);
    },
  );

  it.each(['1,5', '10,50', '1,25'])(
    'refuses %s, a decimal comma, rather than read it as grouping',
    (typed) => {
      const out = parseCreditLimit('limit', typed);
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toMatch(/^Use a point for decimals\./);
    },
  );

  it('refuses an empty amount when a limit is chosen', () => {
    expect(parseCreditLimit('limit', '')).toEqual({ ok: false, error: LIMIT_REQUIRED });
  });

  it.each(['12.345', '-5', '-0.01', '1e5', 'abc', '10.', '.50', '12345678901234567'])(
    'refuses %s',
    (raw) => {
      expect(parseCreditLimit('limit', raw)).toEqual({ ok: false, error: LIMIT_INVALID });
    },
  );

  it('refuses a missing or tampered choice', () => {
    expect(parseCreditLimit('', '100')).toEqual({ ok: false, error: INCOMPLETE });
    expect(parseCreditLimit('zero', '100')).toEqual({ ok: false, error: INCOMPLETE });
  });
});

describe('sameLimit', () => {
  it('treats one amount written two ways as the same', () => {
    expect(sameLimit('100000', '100000.00')).toBe(true);
    expect(sameLimit('0', '0.00')).toBe(true);
    expect(sameLimit('0100.5', '100.50')).toBe(true);
  });

  it('keeps no limit apart from zero', () => {
    expect(sameLimit(null, '0.00')).toBe(false);
    expect(sameLimit('0.00', null)).toBe(false);
    expect(sameLimit(null, null)).toBe(true);
    expect(sameLimit('100.00', '100.01')).toBe(false);
  });
});

describe('staleMessage', () => {
  it('names the shared terms for a terms field and the customer for the owner', () => {
    expect(staleMessage('creditLimit')).toContain("this customer's terms");
    expect(staleMessage('paymentTerms')).toContain("this customer's terms");
    expect(staleMessage('owner')).toContain('changed this customer while');
  });
});
