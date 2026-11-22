import { getCountries } from 'libphonenumber-js/min';
import { describe, expect, it } from 'vitest';

import { formatAddressLines, PrintAddressSchema } from './addresses.js';
import {
  type CountryCode,
  CountryCodeSchema,
  ISO_COUNTRIES,
  countriesWithDialCode,
  countryCallingCode,
  countryName,
} from './countries.js';
import {
  MAX_PARTY_PHONES,
  PartyPhoneInputSchema,
  PartyPhonesSchema,
  formatPartyPhoneForPrint,
  phoneCountryFromE164,
  phoneProblem,
} from './phones.js';

const row = (country: CountryCode, e164: string, isPrimary = false) => ({
  country,
  e164,
  isPrimary,
});

describe('ISO countries', () => {
  it('lists the 249 ISO 3166-1 codes, sorted and unique', () => {
    expect(ISO_COUNTRIES).toHaveLength(249);
    expect(new Set(ISO_COUNTRIES).size).toBe(249);
    expect([...ISO_COUNTRIES].sort()).toEqual([...ISO_COUNTRIES]);
  });

  it('covers every libphonenumber country except the non-ISO AC, TA and XK', () => {
    const iso = new Set<string>(ISO_COUNTRIES);
    const missing = getCountries().filter(
      (code) => !iso.has(code) && !['AC', 'TA', 'XK'].includes(code),
    );
    expect(missing).toEqual([]);
    const noDialCode = ISO_COUNTRIES.filter((code) => countryCallingCode(code) === null);
    expect(noDialCode).toEqual(['AQ', 'BV', 'GS', 'HM', 'PN', 'TF', 'UM']);
    expect(countriesWithDialCode()).toHaveLength(249 - noDialCode.length);
    expect(countriesWithDialCode()).not.toContain('AQ');
  });

  it('names every code', () => {
    for (const code of ISO_COUNTRIES) expect(countryName(code)).not.toBe(code);
    expect(countryName('NP')).toBe('Nepal');
  });

  it('gives calling codes, none for Antarctica', () => {
    expect(countryCallingCode('NP')).toBe('977');
    expect(countryCallingCode('US')).toBe('1');
    expect(countryCallingCode('AQ')).toBeNull();
  });

  it('refuses a code outside the list', () => {
    expect(CountryCodeSchema.safeParse('XK').success).toBe(false);
    expect(CountryCodeSchema.safeParse('np').success).toBe(false);
  });
});

describe('phoneProblem', () => {
  it('accepts a +1 number for US and for CA (shared code +1, accepted for both), not for NP', () => {
    expect(phoneProblem('US', '+14155552671')).toBeNull();
    expect(phoneProblem('CA', '+14155552671')).toBeNull();
    expect(phoneProblem('NP', '+14155552671')).not.toBeNull();
  });

  it('accepts +7 numbers for RU and KZ and a +44 number for GB', () => {
    expect(phoneProblem('RU', '+74951234567')).toBeNull();
    expect(phoneProblem('KZ', '+77012345678')).toBeNull();
    expect(phoneProblem('GB', '+442071838750')).toBeNull();
    // Shared code +7: a Russian number is accepted for KZ and a Kazakh one for RU.
    expect(phoneProblem('KZ', '+74951234567')).toBeNull();
    expect(phoneProblem('RU', '+77012345678')).toBeNull();
    expect(phoneProblem('GB', '+74951234567')).not.toBeNull();
  });

  it('refuses an invalid US number and a Nepal number filed under US', () => {
    expect(phoneProblem('US', '+11235550123')).not.toBeNull();
    expect(phoneProblem('US', '+9779812345678')).not.toBeNull();
  });

  it('keeps the Nepal rules', () => {
    expect(phoneProblem('NP', '+9779812345678')).toBeNull();
    expect(phoneProblem('NP', '+97714123456')).toBeNull();
    expect(phoneProblem('NP', '+97709812345678')).toMatch(/leading 0/);
    expect(phoneProblem('NP', '+9778812345678')).not.toBeNull();
  });

  it('reads a short Nepal number starting with 9 as a mobile missing digits, not a landline', () => {
    // No Nepal landline area code starts with 9, and the workspace box will not save one.
    expect(phoneProblem('NP', '+9779812345')).toMatch(/starting with 9 is a 10-digit mobile/);
    expect(phoneProblem('NP', '+97798123456')).not.toBeNull();
    expect(phoneProblem('NP', '+977981234567')).not.toBeNull();
    expect(phoneProblem('NP', '+97798123456789')).not.toBeNull();
    expect(phoneProblem('NP', '+97714123456')).toBeNull();
    expect(phoneProblem('NP', '+9778123456')).toBeNull();
    expect(phoneProblem('NP', '+9779812345678')).toBeNull();
    expect(phoneProblem('NP', '+9771412345678')).toMatch(/starts with 9/);
  });

  it('refuses spaces and punctuation, so one number has one spelling', () => {
    expect(phoneProblem('US', '+1 415 555 2671')).not.toBeNull();
    expect(phoneProblem('NP', '+977 9812345678')).not.toBeNull();
    expect(phoneProblem('NP', '+977981234567x')).not.toBeNull();
  });

  it('refuses any number for a country without a calling code', () => {
    expect(phoneProblem('AQ', '+14155552671')).not.toBeNull();
  });
});

describe('PartyPhoneInputSchema', () => {
  it('reports the problem on e164', () => {
    const result = PartyPhoneInputSchema.safeParse(row('US', '+9779812345678', true));
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(['e164']);
  });

  it('takes an optional label and refuses unknown keys', () => {
    expect(
      PartyPhoneInputSchema.safeParse({ ...row('NP', '+9779812345678'), label: 'mobile' }).success,
    ).toBe(true);
    expect(
      PartyPhoneInputSchema.safeParse({ ...row('NP', '+9779812345678'), label: null }).success,
    ).toBe(true);
    expect(
      PartyPhoneInputSchema.safeParse({ ...row('NP', '+9779812345678'), label: 'fax' }).success,
    ).toBe(false);
    expect(
      PartyPhoneInputSchema.safeParse({ ...row('NP', '+9779812345678'), extra: 1 }).success,
    ).toBe(false);
  });
});

describe('PartyPhonesSchema', () => {
  it('accepts a Nepal and a US number together', () => {
    const phones = [
      row('NP', '+9779812345678', true),
      { ...row('US', '+14155552671'), label: 'work' },
    ];
    expect(PartyPhonesSchema.parse(phones)).toEqual(phones);
  });

  it('accepts no numbers', () => {
    expect(PartyPhonesSchema.safeParse([]).success).toBe(true);
  });

  it('refuses a repeated number', () => {
    const phones = [row('NP', '+9779812345678', true), row('NP', '+9779812345678')];
    expect(PartyPhonesSchema.safeParse(phones).success).toBe(false);
  });

  it('refuses two primaries and refuses rows with no primary', () => {
    expect(
      PartyPhonesSchema.safeParse([
        row('NP', '+9779812345678', true),
        row('US', '+14155552671', true),
      ]).success,
    ).toBe(false);
    expect(
      PartyPhonesSchema.safeParse([row('NP', '+9779812345678'), row('US', '+14155552671')]).success,
    ).toBe(false);
  });

  it(`refuses more than ${MAX_PARTY_PHONES} numbers`, () => {
    const phones = [
      '+9779812345671',
      '+9779812345672',
      '+9779812345673',
      '+9779812345674',
      '+9779812345675',
      '+9779812345676',
    ].map((e164, index) => row('NP', e164, index === 0));
    expect(PartyPhonesSchema.safeParse(phones.slice(0, 5)).success).toBe(true);
    expect(PartyPhonesSchema.safeParse(phones).success).toBe(false);
  });
});

describe('phoneCountryFromE164', () => {
  it.each([
    ['+977', 'NP'],
    ['+97798', 'NP'],
    ['+1', 'US'],
    ['+1415', 'US'],
    ['+14155552671', 'US'],
    ['+1 4155552671', 'US'],
    ['+7', 'RU'],
    ['+77012345678', 'KZ'],
    ['+44', 'GB'],
    ['+91', 'IN'],
  ])('%s is %s', (typed, country) => {
    expect(phoneCountryFromE164(typed)).toBe(country);
  });

  it('finds nothing without a plus or a known code', () => {
    expect(phoneCountryFromE164('9812345678')).toBeNull();
    expect(phoneCountryFromE164('+')).toBeNull();
    expect(phoneCountryFromE164('+800')).toBeNull();
  });
});

describe('formatPartyPhoneForPrint', () => {
  it.each([
    ['+9779812345678', '+977 9812345678'],
    ['+97714123456', '+977 1-4123456'],
    ['+97761523456', '+977 61-523456'],
    ['+977123', '+977123'],
    ['+977 1-4123456', '+977 1-4123456'],
    ['+14155552671', '+1 415 555 2671'],
    ['+442071838750', '+44 20 7183 8750'],
    ['+11235550123', '+11235550123'],
    ['01-4123456', '01-4123456'],
  ])('%s prints as %s', (given, printed) => {
    expect(formatPartyPhoneForPrint(given)).toBe(printed);
  });
});

describe('addresses', () => {
  const address = { line: 'Baneshwor-10', city: 'Kathmandu' };

  it('omits the entity’s own country', () => {
    expect(formatAddressLines(address, 'NP', 'NP')).toEqual(['Baneshwor-10', 'Kathmandu']);
    expect(formatAddressLines(address, 'IN', 'NP')).toEqual(['Baneshwor-10', 'Kathmandu', 'India']);
    expect(formatAddressLines(address, 'NP')).toEqual(['Baneshwor-10', 'Kathmandu', 'Nepal']);
  });

  it('refuses a printed address without a country', () => {
    expect(PrintAddressSchema.safeParse(address).success).toBe(false);
    expect(PrintAddressSchema.safeParse({ ...address, country: 'NP' }).success).toBe(true);
  });

  it('refuses a foreign number written with its trunk 0 after the country code', () => {
    expect(phoneProblem('GB', '+4407911123456')).not.toBeNull();
    expect(phoneProblem('GB', '+447911123456')).toBeNull();
  });
});
