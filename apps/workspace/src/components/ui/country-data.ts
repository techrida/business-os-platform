// The country list the CountrySelect and phone rows show: ISO code, name, emoji flag and calling code, sorted by
// name with Nepal pinned first, plus the search that ranks them. No React, so every rule here is unit-tested.
import {
  countryCallingCode,
  countryName,
  DEFAULT_COUNTRY,
  ISO_COUNTRIES,
  phoneCountryFromE164,
  type CountryCode,
} from '@bos/contracts';

export interface CountryOption {
  code: CountryCode;
  /** English name (`'Nepal'`). */
  name: string;
  /** Emoji flag from the regional-indicator letters. Some systems draw it as two letters, so never show it alone. */
  flag: string;
  /** Calling code without the plus (`'977'`), or null for a territory with no phone numbers (AQ, BV). */
  dial: string | null;
}

const REGIONAL_A = 0x1f1e6;

/** The emoji flag of an ISO 3166-1 alpha-2 code: `'NP'` becomes the two regional-indicator letters N and P. */
export function countryFlag(code: string): string {
  if (!/^[A-Z]{2}$/.test(code)) return '';
  return String.fromCodePoint(...[...code].map((letter) => REGIONAL_A + letter.charCodeAt(0) - 65));
}

/** `'+977'`, or `''` when the country has no calling code. */
export const dialLabel = (option: Pick<CountryOption, 'dial'>): string =>
  option.dial === null ? '' : `+${option.dial}`;

const collator = new Intl.Collator('en', { sensitivity: 'base' });

let cached: readonly CountryOption[] | null = null;

/** Every ISO country, Nepal first, then by English name. Built once. */
export function countryOptions(): readonly CountryOption[] {
  if (cached !== null) return cached;
  const all = ISO_COUNTRIES.map((code): CountryOption => ({
    code,
    name: countryName(code),
    flag: countryFlag(code),
    dial: countryCallingCode(code),
  }));
  all.sort((a, b) =>
    a.code === DEFAULT_COUNTRY
      ? -1
      : b.code === DEFAULT_COUNTRY
        ? 1
        : collator.compare(a.name, b.name) || a.code.localeCompare(b.code),
  );
  cached = all;
  return all;
}

/** The countries a phone number can belong to: those with a calling code, in the same order. */
export function phoneCountryOptions(): readonly CountryOption[] {
  return countryOptions().filter((option) => option.dial !== null);
}

/** The option for `code`. Every CountryCode has one. */
export function countryOption(code: CountryCode): CountryOption {
  return countryOptions().find((option) => option.code === code)!;
}

/** Common names people type that the ISO name does not contain. */
const ALIASES: Partial<Record<CountryCode, string>> = {
  US: 'usa america united states of america',
  GB: 'uk britain great britain england scotland wales',
  AE: 'uae emirates',
  KR: 'south korea',
  KP: 'north korea',
  CZ: 'czech republic',
  NL: 'holland',
  RU: 'russia',
  CN: 'prc',
};

const fold = (value: string) =>
  value
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9+ ]/g, ' ');

/**
 * Lower is better; null drops the option. Typing a calling code (`977`, `+1`) matches by code, with the code's main
 * country first (`+1` is US before Canada and the islands). Text matches the ISO code exactly first, then a name that
 * starts with it, then a word that does, then anywhere.
 */
function score(
  option: CountryOption,
  query: string,
  mainOfDial: CountryCode | null,
): number | null {
  const digits = /^\+?\s*(\d[\d\s]*)$/.exec(query)?.[1]?.replace(/\s/g, '');
  if (digits !== undefined) {
    if (option.dial === null || !option.dial.startsWith(digits)) return null;
    if (option.dial === digits) return option.code === mainOfDial ? 0 : 1;
    return 2;
  }
  const folded = fold(query).trim().replace(/\s+/g, ' ');
  if (folded === '') return 0;
  const aliases = fold(ALIASES[option.code] ?? '');
  if (option.code.toLowerCase() === folded || ` ${aliases} `.includes(` ${folded} `)) return 0;
  const name = fold(option.name).replace(/\s+/g, ' ').trim();
  if (name.startsWith(folded)) return 1;
  const words = `${name} ${aliases}`.split(' ').filter(Boolean);
  if (words.some((word) => word.startsWith(folded))) return 2;
  const haystack = `${name} ${aliases}`;
  if (folded.split(' ').every((part) => haystack.includes(part))) return 3;
  return null;
}

/**
 * The options that match `query`, best first; ties keep the list's own order (Nepal first, then by name). Matches
 * the name (`nep`), the ISO code (`np`, `US`) and the calling code with or without its plus (`977`, `+1`). An empty
 * query returns the list as given.
 */
export function searchCountries(
  query: string,
  options: readonly CountryOption[] = countryOptions(),
): CountryOption[] {
  const trimmed = query.trim();
  if (trimmed === '') return [...options];
  const digits = /^\+?\s*(\d[\d\s]*)$/.exec(trimmed)?.[1]?.replace(/\s/g, '');
  const mainOfDial = digits === undefined ? null : phoneCountryFromE164(`+${digits}`);
  return options
    .map((option, index) => ({ option, index, rank: score(option, trimmed, mainOfDial) }))
    .filter(
      (entry): entry is { option: CountryOption; index: number; rank: number } =>
        entry.rank !== null,
    )
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map((entry) => entry.option);
}
