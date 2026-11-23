// What the one-box phone field makes of the text typed into it (R6S, UIP-FORM-007). Pure functions, no React, so every
// rule is unit-tested in phone-detect.test.ts.
//
// The field shows the number once, code first (`+977 9812345678`). The user never has to type the `+`, so the text
// arrives in two shapes:
//
//   * Written with `+` or `00` in front: a whole international number. The country follows the calling code, by the
//     contracts' `phoneCountryFromE164` (main country of a shared code; +1 and +7 resolve by area code once the number is
//     complete), and a country the user picked on purpose is kept when the detected one only shares its calling code
//     (a picked Canada stays Canada for `+1 204…`; R6A's rule).
//   * Bare digits (a first digit typed into the empty field, or the text pasted over the whole box): the digits of the
//     current country's national number unless they plainly are not. Typing and pasting differ, because typing goes one
//     digit at a time and a misread country mid-number is worse than a late switch:
//       - Pasted (the whole box replaced): national when the digits are a valid national number of the current country
//         (`9123456789` in India is a mobile, not +91 23456789). Otherwise, when they are a complete valid international
//         number under their leading calling code, international: `91 98765 43210` under the United States is India. A
//         trunk 0 that only parses away (`020 7946 0958`) is dropped.
//       - Typed, in a country the user did not pick: national, until the digits are exactly a calling code that cannot
//         start a national number (`977` under the United States or Nepal; `91` is a real US start, `212` is a New York
//         area code, so neither switches). Then the country follows the code, which ends bare typing: the next digits
//         are read after the code. A country the user picked is never switched by bare digits (type the `+`).
//       - Typed, one digit past a complete valid national number: refused by the field (`refusesExtraDigit`), so a typo
//         cannot turn a US number into a Swiss one.
//     A valid number that only parses because libphonenumber stripped the country's own code (`919876543210` in India,
//     `14155552671` in the US) is read as international when it starts with the code.
//
// The 'max' metadata is used for the "could this be a national number" test only (its per-type patterns know that no
// US area code is 977); what is saved is still checked by the contracts' `phoneProblem` on the 'min' metadata.
import { countryCallingCode, phoneCountryFromE164, type CountryCode } from '@bos/contracts';
import {
  AsYouType,
  getExampleNumber,
  parsePhoneNumberFromString,
  type CountryCode as LibCountryCode,
} from 'libphonenumber-js/max';
import examples from 'libphonenumber-js/examples.mobile.json';

/** The longest an E.164 number is (country code included). */
export const E164_MAX_DIGITS = 15;

/** What the field makes of its text: the number as E.164 (partial while typing, `''` when empty) and its country. */
export interface PhoneTyped {
  country: CountryCode;
  e164: string;
}

export interface TypingContext {
  /** The row's country before this keystroke. */
  country: CountryCode;
  /** Whether the user picked it in the flag menu. */
  picked: boolean;
}

const dialOf = (country: CountryCode): string => countryCallingCode(country) ?? '';

/**
 * The country after a number is typed or pasted: the detected one, except that a country the user picked on purpose
 * stays when the detected one only shares its calling code.
 */
export function countryAfterTyping(
  current: TypingContext,
  detected: CountryCode | null,
): CountryCode {
  if (detected === null) return current.country;
  const dial = countryCallingCode(current.country);
  if (current.picked && dial !== null && dial === countryCallingCode(detected)) {
    return current.country;
  }
  return detected;
}

const TAILS = ['2345678901234', '5550100987654', '9876543210123'] as const;

/**
 * Whether `digits`, nothing stripped from them, are a valid national number of `country` or the start of one: some
 * completion is valid. The first three digits are completed with every combination (an area code is up to three
 * digits and which ones exist is what tells `977` from `480`), then the number is filled out with a few different
 * tails. Only used with an exact calling code (`977`, `91`) to decide whether that is the start of a national number.
 */
export function couldBeNational(country: CountryCode, digits: string): boolean {
  if (digits === '') return true;
  const max = E164_MAX_DIGITS - dialOf(country).length;
  const heads =
    digits.length >= 3
      ? [digits]
      : Array.from(
          { length: 10 ** (3 - digits.length) },
          (_, n) => `${digits}${String(n).padStart(3 - digits.length, '0')}`,
        );
  for (const head of heads) {
    for (let length = Math.max(head.length, 4); length <= max; length += 1) {
      for (const tail of TAILS) {
        const candidate = `${head}${tail}`.slice(0, length);
        const parsed = parsePhoneNumberFromString(candidate, country as LibCountryCode);
        if (parsed?.isValid() === true && parsed.nationalNumber === candidate) return true;
      }
    }
  }
  return false;
}

/** Whether `digits` are, as typed, a complete valid national number of `country`. */
export function isCompleteNational(country: CountryCode, digits: string): boolean {
  const parsed = parsePhoneNumberFromString(digits, country as LibCountryCode);
  return parsed?.isValid() === true && parsed.nationalNumber === digits;
}

/**
 * Whether typing one more digit after `before` should be refused: `before` is a complete valid national number and
 * `after` (one digit longer) can no longer become one, so the digit is more likely a typo than the start of a foreign
 * code. (A 7-digit Nepal landline followed by an 8th digit is still on its way to a 10-digit mobile: not refused.)
 */
export function refusesExtraDigit(country: CountryCode, before: string, after: string): boolean {
  // Nepal keeps FX8's rule: a mobile is ten digits starting with 9, a landline 7 to 9 digits (libphonenumber knows
  // only the 8-digit ones), so only a complete mobile refuses another digit.
  if (country === 'NP') {
    return (
      before.length === 10 &&
      before.startsWith('9') &&
      after.length === 11 &&
      after.startsWith(before)
    );
  }
  return (
    before !== '' &&
    after.length === before.length + 1 &&
    after.startsWith(before) &&
    isCompleteNational(country, before) &&
    !couldBeNational(country, after)
  );
}

/**
 * What the text typed or pasted into the field means. Letters and punctuation are ignored; digits are capped at 15.
 * `via` is how it got there: `type` (one edit at a time) or `paste` (a whole number at once).
 */
export function interpretTyped(
  text: string,
  current: TypingContext,
  via: 'type' | 'paste' = 'type',
): PhoneTyped {
  const trimmed = text.trimStart();
  const international = trimmed.startsWith('+') || trimmed.startsWith('00');
  const all = text.replace(/\D/g, '');
  const digits = (international && trimmed.startsWith('00') ? all.slice(2) : all).slice(
    0,
    E164_MAX_DIGITS,
  );
  if (digits === '') return { country: current.country, e164: '' };
  if (international) {
    const e164 = `+${digits}`;
    return { country: countryAfterTyping(current, phoneCountryFromE164(e164)), e164 };
  }

  const dial = dialOf(current.country);
  const national: PhoneTyped = { country: current.country, e164: `+${dial}${digits}` };
  const intl = (): PhoneTyped | null => {
    const detected = phoneCountryFromE164(`+${digits}`);
    return detected === null
      ? null
      : { country: countryAfterTyping(current, detected), e164: `+${digits}` };
  };
  if (dial === '') return intl() ?? national;

  const own = parsePhoneNumberFromString(digits, current.country as LibCountryCode);
  if (own?.isValid() === true) {
    if (own.nationalNumber === digits) return national;
    // Valid only because the own code was dropped (`14155552671`): the user typed the code.
    if (digits.startsWith(dial)) return { country: current.country, e164: `+${digits}` };
    // A pasted number with its trunk 0 (`020 7946 0958`): E.164 leaves the 0 out.
    return via === 'paste' ? { country: current.country, e164: own.number } : national;
  }

  const code = (() => {
    const detected = phoneCountryFromE164(`+${digits}`);
    return detected === null ? null : countryCallingCode(detected);
  })();
  if (via === 'paste') {
    const parsed = parsePhoneNumberFromString(`+${digits}`);
    return parsed?.isValid() === true ? (intl() ?? national) : national;
  }
  // Typed: only an exact calling code that cannot start a national number, and only where the user has not picked.
  if (
    !current.picked &&
    code !== null &&
    digits === code &&
    !couldBeNational(current.country, digits)
  ) {
    return intl() ?? national;
  }
  return national;
}

/**
 * The number as the field shows it: the code once, then the number in the country's own grouping as far as it is typed
 * (`+44 7911 123456`). Nepal keeps FX8's print form, `+977 9812345678`; `''` for no number.
 */
export function displayPhone(e164: string): string {
  if (e164 === '') return '';
  if (e164.startsWith('+977')) {
    const national = e164.slice(4);
    if (!/^\d+$/.test(national)) return e164;
    if (national.length === 0) return '+977';
    if (national.startsWith('9') || national.length <= 2) return `+977 ${national}`;
    const area = national.startsWith('1') ? 1 : 2;
    return `+977 ${national.slice(0, area)}-${national.slice(area)}`;
  }
  return new AsYouType().input(e164);
}

/** An example number for the placeholder: the country's own mobile example, with its code and grouping. */
export function examplePhone(country: CountryCode): string {
  if (country === 'NP') return '+977 9812345678';
  const example = getExampleNumber(country as LibCountryCode, examples);
  return example === undefined ? `+${dialOf(country)}` : displayPhone(example.number);
}

/** The digits of a displayed number, in order; the caret is carried across a reformat by counting them. */
export const digitCount = (text: string, upTo = text.length): number =>
  text.slice(0, upTo).replace(/\D/g, '').length;

/** The caret position in `text` that sits after `count` digits (the end when it has fewer). */
export function caretAfterDigits(text: string, count: number): number {
  if (count <= 0) return text.startsWith('+') ? 1 : 0;
  let seen = 0;
  for (let index = 0; index < text.length; index += 1) {
    if (/\d/.test(text[index]!)) seen += 1;
    if (seen === count) return index + 1;
  }
  return text.length;
}
