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
//   * Bare digits (a first digit typed into the empty field, or the text pasted over the whole box): digits of the
//     current country's national number, unless they cannot be one. Decided in this order:
//       1. The digits are a complete valid national number of the current country: national. (Nothing is read as a code
//          when the whole number is already valid. `9123456789` in India is a mobile, not +91 23456789.)
//       2. They still could become one (a strict probe: some completion is a valid national number, with nothing
//          stripped): national. A country picked on purpose is therefore kept while the typing is a possible national
//          start (UIP-FORM-007). `977…` is not a possible national start in Nepal (no mobile range 977) or the United
//          States (no area code 977), so under either it is read next, as Nepal's code.
//       3. They begin with a calling code (prefix-free, so there is one): international, the country follows the code,
//          and the code is not typed twice (`1 415…` in a Nepal row is the United States, `977…` in a US row is Nepal).
//       4. Anything else stays national and is reported as invalid by `problemOf`.
//     A valid number that only parses because libphonenumber stripped the country's own code or a trunk prefix
//     (`919876543210` in India, `14155552671` in the US) is read as international when it starts with the code.
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

const PADS = ['2345678901234', '5550100987654', '9876543210123'] as const;

/** Whether `digits`, nothing stripped from them, are a valid national number of `country` or the start of one. */
export function couldBeNational(country: CountryCode, digits: string): boolean {
  if (digits === '') return true;
  const max = E164_MAX_DIGITS - dialOf(country).length;
  for (let length = digits.length; length <= max; length += 1) {
    for (const pad of PADS) {
      const candidate = `${digits}${pad}`.slice(0, length);
      const parsed = parsePhoneNumberFromString(candidate, country as LibCountryCode);
      if (parsed?.isValid() === true && parsed.nationalNumber === candidate) return true;
    }
  }
  return false;
}

/** What the text typed or pasted into the field means. Letters and punctuation are ignored; digits are capped at 15. */
export function interpretTyped(text: string, current: TypingContext): PhoneTyped {
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
  if (dial === '') {
    const detected = phoneCountryFromE164(`+${digits}`);
    return detected === null
      ? national
      : { country: countryAfterTyping(current, detected), e164: `+${digits}` };
  }
  const own = parsePhoneNumberFromString(digits, current.country as LibCountryCode);
  if (own?.isValid() === true) {
    if (own.nationalNumber === digits) return national;
    // Valid only because the own code was dropped (`14155552671`): the user typed the code.
    if (digits.startsWith(dial)) return { country: current.country, e164: `+${digits}` };
    return national;
  }
  if (couldBeNational(current.country, digits)) return national;
  const detected = phoneCountryFromE164(`+${digits}`);
  const code = detected === null ? null : countryCallingCode(detected);
  if (detected !== null && code !== null && digits.length >= code.length) {
    return { country: countryAfterTyping(current, detected), e164: `+${digits}` };
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
