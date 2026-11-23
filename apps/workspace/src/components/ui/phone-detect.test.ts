import { describe, expect, it } from 'vitest';

import {
  caretAfterDigits,
  couldBeNational,
  digitCount,
  displayPhone,
  examplePhone,
  interpretTyped,
  refusesExtraDigit,
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

describe('interpretTyped: typed without a plus (UIP-FORM-007)', () => {
  it('reads digits as the current country national number', () => {
    expect(interpretTyped('9', np)).toEqual({ country: 'NP', e164: '+9779' });
    expect(interpretTyped('9812345678', np)).toEqual({ country: 'NP', e164: '+9779812345678' });
    expect(interpretTyped('415', us)).toEqual({ country: 'US', e164: '+1415' });
    expect(interpretTyped('4155552671', us)).toEqual({ country: 'US', e164: '+14155552671' });
    // A complete valid national number is never read as a code: 9123456789 is an Indian mobile.
    expect(interpretTyped('9123456789', inIndia)).toEqual({ country: 'IN', e164: '+919123456789' });
  });

  it('switches at exactly a calling code that cannot start a national number: 977 under the US or Nepal', () => {
    expect(couldBeNational('US', '977')).toBe(false);
    expect(couldBeNational('NP', '977')).toBe(false);
    expect(interpretTyped('977', us)).toEqual({ country: 'NP', e164: '+977' });
    expect(interpretTyped('977', np)).toEqual({ country: 'NP', e164: '+977' });
    // India has 977… mobile numbers, so there it stays a national start.
    expect(interpretTyped('977', inIndia).country).toBe('IN');
  });

  it('does not switch on real national starts that look like a code: 91, 212, 480, 757 under the US', () => {
    for (const start of ['4', '48', '480', '75', '757', '91', '212', '44', '650', '310', '541']) {
      expect(interpretTyped(start, us).country, start).toBe('US');
    }
  });

  it('does not switch on real national starts in other countries', () => {
    expect(interpretTyped('2079460958', { country: 'GB', picked: false }).country).toBe('GB');
    expect(interpretTyped('2226781234', inIndia).country).toBe('IN');
    for (const start of ['9', '98', '984', '985', '97', '1', '14', '44']) {
      expect(interpretTyped(start, np).country, start).toBe('NP');
    }
  });

  it('never switches a country the user picked on bare digits', () => {
    expect(interpretTyped('977', { country: 'US', picked: true })).toEqual({
      country: 'US',
      e164: '+1977',
    });
    expect(interpretTyped('415', { country: 'US', picked: true }).country).toBe('US');
  });

  it('reads the own code typed in front of a US number as the same country, written once', () => {
    expect(interpretTyped('14155552671', us)).toEqual({ country: 'US', e164: '+14155552671' });
  });

  it('ignores letters and punctuation, and caps the digits at 15', () => {
    expect(interpretTyped('98-1234 abc 5678', np).e164).toBe('+9779812345678');
    expect(interpretTyped('+', np)).toEqual({ country: 'NP', e164: '' });
    expect(interpretTyped('+123456789012345678', np).e164).toBe('+123456789012345');
    expect(interpretTyped('', us)).toEqual({ country: 'US', e164: '' });
  });
});

describe('interpretTyped: pasted without a plus', () => {
  it('reads a complete international number under its calling code, in any current country', () => {
    expect(interpretTyped('91 98765 43210', us, 'paste')).toEqual({
      country: 'IN',
      e164: '+919876543210',
    });
    expect(interpretTyped('91 98765 43210', np, 'paste')).toEqual({
      country: 'IN',
      e164: '+919876543210',
    });
    expect(interpretTyped('919876543210', inIndia, 'paste')).toEqual({
      country: 'IN',
      e164: '+919876543210',
    });
    expect(interpretTyped('1 415 555 2671', np, 'paste')).toEqual({
      country: 'US',
      e164: '+14155552671',
    });
    expect(interpretTyped('9779812345678', us, 'paste')).toEqual({
      country: 'NP',
      e164: '+9779812345678',
    });
    expect(interpretTyped('9779812345678', np, 'paste')).toEqual({
      country: 'NP',
      e164: '+9779812345678',
    });
  });

  it('drops the trunk 0 of a pasted national number', () => {
    expect(interpretTyped('020 7946 0958', { country: 'GB', picked: false }, 'paste')).toEqual({
      country: 'GB',
      e164: '+442079460958',
    });
    expect(interpretTyped('01 4123456', np, 'paste')).toEqual({
      country: 'NP',
      e164: '+97714123456',
    });
  });
});

describe('refusesExtraDigit', () => {
  it('refuses one digit past a complete valid national number, not a longer valid one', () => {
    expect(refusesExtraDigit('US', '4155552671', '41555526719')).toBe(true);
    expect(refusesExtraDigit('NP', '9812345678', '98123456789')).toBe(true);
    expect(refusesExtraDigit('NP', '9812345', '98123456')).toBe(false);
    expect(refusesExtraDigit('US', '415555267', '4155552671')).toBe(false);
    expect(refusesExtraDigit('NP', '14123456', '141234567')).toBe(false);
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
