import { describe, expect, it } from 'vitest';

import {
  caretAfterDigits,
  couldBeNational,
  digitCount,
  displayPhone,
  examplePhone,
  interpretTyped,
} from './phone-detect';

const np = { country: 'NP' as const, picked: false };
const us = { country: 'US' as const, picked: false };
const inIndia = { country: 'IN' as const, picked: false };

describe('placeholder: an example number per country', () => {
  it.each([
    ['NP', '+977 9812345678'],
    ['IN', '+91 81234 56789'],
    ['US', '+1 201 555 0123'],
    ['GB', '+44 7400 123456'],
  ] as const)('%s shows %s', (country, example) => {
    expect(examplePhone(country)).toBe(example);
  });
});

describe('displayPhone shows the code once, in the number', () => {
  it.each([
    ['+9779812345678', '+977 9812345678'],
    ['+97714123456', '+977 1-4123456'],
    ['+977', '+977'],
    ['+14155552671', '+1 415 555 2671'],
    ['+447911123456', '+44 7911 123456'],
    ['', ''],
  ])('%s -> %s', (e164, shown) => {
    expect(displayPhone(e164)).toBe(shown);
  });
});

describe('interpretTyped: with a plus', () => {
  it('switches the country by the typed code, with or without spaces', () => {
    expect(interpretTyped('+91 98765 43210', np)).toEqual({ country: 'IN', e164: '+919876543210' });
    expect(interpretTyped('+977 9812345678', us)).toEqual({
      country: 'NP',
      e164: '+9779812345678',
    });
    expect(interpretTyped('0091 98765 43210', np)).toEqual({
      country: 'IN',
      e164: '+919876543210',
    });
  });

  it('shows a shared code by its main country until the number is complete, then by area code', () => {
    expect(interpretTyped('+1 4', np)).toEqual({ country: 'US', e164: '+14' });
    expect(interpretTyped('+1 416', np).country).toBe('US');
    expect(interpretTyped('+1 416 555 1234', np)).toEqual({ country: 'CA', e164: '+14165551234' });
    expect(interpretTyped('+44 7911 11', np).country).toBe('GB');
    expect(interpretTyped('+7 701 234 5678', np).country).toBe('KZ');
  });

  it('keeps a country the user picked when the detected one only shares its calling code', () => {
    const canada = { country: 'CA' as const, picked: true };
    expect(interpretTyped('+1 415 555 2671', canada).country).toBe('CA');
    expect(interpretTyped('+977 9812345678', canada).country).toBe('NP');
    expect(interpretTyped('+1 415 555 2671', { country: 'CA', picked: false }).country).toBe('US');
  });
});

describe('interpretTyped: without a plus (UIP-FORM-007)', () => {
  it('reads digits as the current country national number while they can be one', () => {
    expect(interpretTyped('9', np)).toEqual({ country: 'NP', e164: '+9779' });
    expect(interpretTyped('9812345678', np)).toEqual({ country: 'NP', e164: '+9779812345678' });
    expect(interpretTyped('415', us)).toEqual({ country: 'US', e164: '+1415' });
    expect(interpretTyped('4155552671', us)).toEqual({ country: 'US', e164: '+14155552671' });
    // A complete valid national number is never read as a code: 9123456789 is an Indian mobile.
    expect(interpretTyped('9123456789', inIndia)).toEqual({ country: 'IN', e164: '+919123456789' });
  });

  it('switches to Nepal when 977… is typed under the United States, no plus needed', () => {
    expect(interpretTyped('977', us)).toEqual({ country: 'NP', e164: '+977' });
    expect(interpretTyped('9779812345678', us)).toEqual({ country: 'NP', e164: '+9779812345678' });
  });

  it('switches to India for 91 98765 43210 typed or pasted under the US and under Nepal', () => {
    expect(interpretTyped('91 98765 43210', us)).toEqual({ country: 'IN', e164: '+919876543210' });
    expect(interpretTyped('91 98765 43210', np)).toEqual({ country: 'IN', e164: '+919876543210' });
    expect(interpretTyped('919876543210', inIndia)).toEqual({
      country: 'IN',
      e164: '+919876543210',
    });
  });

  it('reads 1 415… under Nepal as the United States', () => {
    expect(interpretTyped('1 415 555 2671', np)).toEqual({ country: 'US', e164: '+14155552671' });
  });

  it('reads the own code typed in front of a US number as the same country, written once', () => {
    expect(interpretTyped('14155552671', us)).toEqual({ country: 'US', e164: '+14155552671' });
    expect(interpretTyped('1415', us)).toEqual({ country: 'US', e164: '+1415' });
  });

  it('under Nepal, 977… is its own code (no Nepal number starts 977), and a real mobile stays national', () => {
    expect(couldBeNational('NP', '977')).toBe(false);
    expect(interpretTyped('977', np)).toEqual({ country: 'NP', e164: '+977' });
    expect(interpretTyped('9779812345678', np)).toEqual({ country: 'NP', e164: '+9779812345678' });
    expect(interpretTyped('984', np)).toEqual({ country: 'NP', e164: '+977984' });
    expect(interpretTyped('9841234567', np)).toEqual({ country: 'NP', e164: '+9779841234567' });
  });

  it('keeps a picked country while the digits are still a possible national start', () => {
    expect(interpretTyped('415', { country: 'US', picked: true })).toEqual({
      country: 'US',
      e164: '+1415',
    });
    expect(interpretTyped('91 98765 43210', { country: 'US', picked: true }).country).toBe('IN');
  });

  it('ignores letters and punctuation, and caps the digits at 15', () => {
    expect(interpretTyped('98-1234 abc 5678', np).e164).toBe('+9779812345678');
    expect(interpretTyped('+', np)).toEqual({ country: 'NP', e164: '' });
    expect(interpretTyped('+123456789012345678', np).e164).toBe('+123456789012345');
    expect(interpretTyped('', us)).toEqual({ country: 'US', e164: '' });
  });
});

describe('caret across a reformat', () => {
  it('counts digits before the caret and finds the same place in the new text', () => {
    expect(digitCount('+977 98', 7)).toBe(5);
    expect(caretAfterDigits('+977 9812345678', 5)).toBe(7);
    expect(caretAfterDigits('+977 9812345678', 0)).toBe(1);
    expect(caretAfterDigits('+977', 99)).toBe(4);
  });
});
