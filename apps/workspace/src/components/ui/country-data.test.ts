import { ISO_COUNTRIES } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  countryFlag,
  countryOption,
  countryOptions,
  dialLabel,
  phoneCountryOptions,
  searchCountries,
} from './country-data';

const codes = (list: readonly { code: string }[]) => list.map((option) => option.code);

describe('country list', () => {
  it('holds every ISO country once, Nepal first, then by name', () => {
    const list = countryOptions();
    expect(list).toHaveLength(ISO_COUNTRIES.length);
    expect(new Set(codes(list)).size).toBe(ISO_COUNTRIES.length);
    expect(list[0]).toMatchObject({ code: 'NP', name: 'Nepal', dial: '977' });
    const rest = list.slice(1).map((option) => option.name);
    const sorted = [...rest].sort((a, b) => a.localeCompare(b, 'en', { sensitivity: 'base' }));
    expect(rest).toEqual(sorted);
  });

  it('builds the flag from regional-indicator letters', () => {
    expect(countryFlag('NP')).toBe('\u{1F1F3}\u{1F1F5}');
    expect(countryFlag('US')).toBe('\u{1F1FA}\u{1F1F8}');
    expect(countryFlag('nope')).toBe('');
    expect(countryOption('IN').flag).toBe(countryFlag('IN'));
  });

  it('gives the calling code, or none for a territory without phones', () => {
    expect(dialLabel(countryOption('US'))).toBe('+1');
    expect(countryOption('AQ').dial).toBeNull();
    expect(dialLabel(countryOption('AQ'))).toBe('');
    expect(codes(phoneCountryOptions())).not.toContain('AQ');
    expect(phoneCountryOptions()[0]!.code).toBe('NP');
  });
});

describe('searchCountries', () => {
  it('returns the whole list for an empty query', () => {
    expect(searchCountries('  ')).toHaveLength(countryOptions().length);
  });

  it('matches the name from its start, then any word, then anywhere', () => {
    expect(codes(searchCountries('nep'))[0]).toBe('NP');
    expect(codes(searchCountries('zeal'))).toContain('NZ');
    expect(codes(searchCountries('india'))[0]).toBe('IN');
  });

  it('puts an exact ISO code first', () => {
    expect(codes(searchCountries('us'))[0]).toBe('US');
    expect(codes(searchCountries('NP'))[0]).toBe('NP');
    expect(codes(searchCountries('gb'))[0]).toBe('GB');
  });

  it('knows the names people type that the ISO name lacks', () => {
    expect(codes(searchCountries('uk'))[0]).toBe('GB');
    expect(codes(searchCountries('usa'))[0]).toBe('US');
  });

  it('matches a calling code with or without its plus, main country first', () => {
    expect(codes(searchCountries('977'))).toEqual(['NP']);
    const plusOne = codes(searchCountries('+1'));
    expect(plusOne[0]).toBe('US');
    expect(plusOne).toContain('CA');
    expect(plusOne).not.toContain('NP');
    expect(codes(searchCountries('+44'))[0]).toBe('GB');
    expect(codes(searchCountries('+91'))[0]).toBe('IN');
  });

  it('finds nothing for nonsense', () => {
    expect(searchCountries('qqqzz')).toEqual([]);
    expect(searchCountries('+999')).toEqual([]);
  });
});
