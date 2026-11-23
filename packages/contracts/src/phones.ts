// Phone numbers of a party (FX9): several per person, each with its own country. A Nepal number keeps FX8's rules
// (a `+9779` mobile, or a 7 to 9 digit landline starting 1 to 8); any other country is checked by libphonenumber-js
// (`min` metadata), and the number's calling code must be the selected country's. Calling codes are compared rather
// than the parsed country, because +1, +7 and +44 are shared: a Canadian number is a valid +1 number for US too.
// This module must not import crm.ts or document-style.ts: document-style imports crm, and crm imports this.
import { z } from 'zod';
import { parsePhoneNumberFromString } from 'libphonenumber-js/min';
import metadata from 'libphonenumber-js/min/metadata';

import {
  type CountryCode,
  CountryCodeSchema,
  countryCallingCode,
  countryName,
  isCountryCode,
} from './countries.js';

/** Nepal's country code. */
const NEPAL_CODE = '+977';

/** E.164: a plus sign, then 7 to 15 digits, nothing else. */
const E164_PATTERN = /^\+[1-9]\d{6,14}$/;

/**
 * Why a Nepal (`+977`) number is not one, or null. A mobile is ten national digits starting with 9; a landline is 7
 * to 9 national digits that start with neither 0 (the trunk 0 is not part of E.164) nor 9 (no landline area code
 * does, so a short number starting with 9 is a mobile missing digits). The workspace's Nepal box applies the same
 * rule. A number from another country is not judged here: the generic E.164 rule covers it.
 */
export function nepalPhoneProblem(phone: string): string | null {
  if (!phone.startsWith(NEPAL_CODE)) return null;
  const national = phone.slice(NEPAL_CODE.length);
  if (national.startsWith('0')) return 'leave out the leading 0 of a Nepal number';
  if (national.startsWith('9')) {
    return national.length === 10 ? null : 'a Nepal number starting with 9 is a 10-digit mobile';
  }
  if (national.length === 10) return 'a Nepal mobile number starts with 9';
  if (national.length >= 7 && national.length <= 9) return null;
  return 'a Nepal number is a 10-digit mobile starting with 9 or a 7 to 9 digit landline';
}

/** What a phone number is for. Optional on a row. */
export const PHONE_LABELS = ['mobile', 'work', 'home', 'landline'] as const;
export const PhoneLabelSchema = z.enum(PHONE_LABELS);
export type PhoneLabel = z.infer<typeof PhoneLabelSchema>;

/** The most phone numbers one person (contact, lead person) carries. */
export const MAX_PARTY_PHONES = 5;

/**
 * Why `e164` is not a phone number of `country`, or null. The number must be strict E.164 (no spaces or
 * punctuation, so two spellings of one number cannot both be stored). A territory without a calling code (AQ, BV)
 * has no phone numbers.
 */
export function phoneProblem(country: CountryCode, e164: string): string | null {
  if (!E164_PATTERN.test(e164)) return 'must be an E.164 number such as +9779812345678';
  if (country === 'NP') {
    if (!e164.startsWith(NEPAL_CODE)) return 'a Nepal number starts with +977';
    return nepalPhoneProblem(e164);
  }
  const code = countryCallingCode(country);
  if (code === null) return `${countryName(country)} has no phone numbers`;
  const parsed = parsePhoneNumberFromString(e164);
  if (parsed === undefined || parsed.countryCallingCode !== code) {
    return `a ${countryName(country)} number starts with +${code}`;
  }
  if (!parsed.isValid()) return `not a valid ${countryName(country)} number`;
  // libphonenumber drops a national trunk 0 (+44 07911...): two spellings of one number would both pass.
  if (parsed.number !== e164) return 'leave out the leading 0 of the national number';
  return null;
}

const partyPhoneShape = {
  country: CountryCodeSchema,
  e164: z.string(),
  label: PhoneLabelSchema.nullable().optional(),
  isPrimary: z.boolean(),
};

const checkPhone = (phone: { country: CountryCode; e164: string }, ctx: z.RefinementCtx) => {
  const problem = phoneProblem(phone.country, phone.e164);
  if (problem !== null) ctx.addIssue({ code: 'custom', message: problem, path: ['e164'] });
};

/** One phone row as a form or import sends it. */
export const PartyPhoneInputSchema = z.strictObject(partyPhoneShape).superRefine(checkPhone);
export type PartyPhoneInput = z.infer<typeof PartyPhoneInputSchema>;

/** One phone row as the API returns it. Reads are as strict as writes (FX9: no legacy rows to tolerate). */
export const PartyPhoneSchema = z.strictObject(partyPhoneShape).superRefine(checkPhone);
export type PartyPhone = z.infer<typeof PartyPhoneSchema>;

/**
 * A person's phone numbers, in display order. None is fine; otherwise exactly one is primary and no number is
 * listed twice.
 */
export const PartyPhonesSchema = z
  .array(PartyPhoneInputSchema)
  .max(MAX_PARTY_PHONES)
  .superRefine((phones, ctx) => {
    if (phones.length === 0) return;
    const primaries = phones.filter((phone) => phone.isPrimary).length;
    if (primaries !== 1) {
      ctx.addIssue({
        code: 'custom',
        message: primaries === 0 ? 'mark one number as primary' : 'only one number can be primary',
      });
    }
    const seen = new Set<string>();
    phones.forEach((phone, index) => {
      if (seen.has(phone.e164)) {
        ctx.addIssue({
          code: 'custom',
          message: 'this number is listed twice',
          path: [index, 'e164'],
        });
      }
      seen.add(phone.e164);
    });
  });
export type PartyPhones = z.infer<typeof PartyPhonesSchema>;

/** The main country of a calling code (`'1'` is US, `'7'` RU, `'44'` GB), from libphonenumber's metadata order. */
function mainCountryOfCallingCode(code: string): CountryCode | null {
  const main = metadata.country_calling_codes[code]?.find((country) => isCountryCode(country));
  return main !== undefined && isCountryCode(main) ? main : null;
}

/**
 * The country a typed number most likely belongs to, or null. Works on a partial number too, so a phone field can
 * switch its country as the user types `+1 4…` (US) or `+977 98…` (NP). A calling code several countries share
 * (+44, +39, +1, +7, +61, +47, +590 and a few more) resolves to its main country (GB, IT, US, RU, AU, NO, GP), also
 * for a complete number that libphonenumber's own patterns would place in a smaller region (`+447911123456` is GB,
 * not GG; `+390612345678` is IT, not VA): people expect the main country (R6A, Kuu 2026-11-23). The number only
 * has to be valid for the code, as `phoneProblem` checks. A deliberate country pick is never overridden here.
 */
export function phoneCountryFromE164(e164: string): CountryCode | null {
  if (!e164.startsWith('+')) return null;
  const digits = e164.slice(1).replace(/\D/g, '');
  if (digits === '') return null;
  if (digits.startsWith(NEPAL_CODE.slice(1))) return 'NP';
  const parsed = parsePhoneNumberFromString(`+${digits}`);
  if (parsed !== undefined && parsed.country !== undefined) {
    const main = mainCountryOfCallingCode(parsed.countryCallingCode);
    if (main !== null && phoneProblem(main, `+${digits}`) === null) return main;
    if (isCountryCode(parsed.country)) return parsed.country;
  }
  // Calling codes are prefix-free, so the first prefix that is one is the only one.
  for (let length = 1; length <= 3 && length <= digits.length; length += 1) {
    const prefix = digits.slice(0, length);
    if (metadata.country_calling_codes[prefix] !== undefined)
      return mainCountryOfCallingCode(prefix);
  }
  return null;
}

/**
 * A party phone as a letterhead, quotation, invoice or PO prints it. A Nepal number keeps FX8's format: a mobile is
 * `+977 9812345678`, a landline puts its area code first, `+977 1-4123456` (Kathmandu) or `+977 61-523456`. A
 * valid foreign number prints in international format (`+1 415 555 2671`). Anything else prints as it is.
 */
export function formatPartyPhoneForPrint(e164: string): string {
  if (e164.startsWith(NEPAL_CODE)) {
    if (!/^\+977\d+$/.test(e164) || nepalPhoneProblem(e164) !== null) return e164;
    const national = e164.slice(NEPAL_CODE.length);
    if (national.length === 10) return `+977 ${national}`;
    const area = national.startsWith('1') ? 1 : 2;
    return `+977 ${national.slice(0, area)}-${national.slice(area)}`;
  }
  if (!E164_PATTERN.test(e164)) return e164;
  const parsed = parsePhoneNumberFromString(e164);
  return parsed?.isValid() === true ? parsed.formatInternational() : e164;
}
