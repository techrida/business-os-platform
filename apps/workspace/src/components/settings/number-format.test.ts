import { DEFAULT_NUMBER_SYSTEMS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  CURRENCY_LABELS,
  dateFormatOptions,
  defaultDateFormatText,
  isDefaultDateFormat,
  isDefaultNumberSystem,
  isLoadedVersion,
  numberSystemFieldName,
  numberSystemOptions,
  numberSystemRows,
  numberSystemsFromForm,
  parseDateFormat,
  parseNumberSystem,
  parseNumberSystems,
  parseVersionField,
  pruneNumberDraft,
  sameNumberSystems,
  todayInKathmandu,
  withCurrencyDefault,
} from './number-format';

describe('numberSystemOptions', () => {
  it('draws NPR examples from the shared formatters', () => {
    const [southAsian, international] = numberSystemOptions('NPR');
    expect(southAsian).toMatchObject({
      value: 'south_asian',
      name: 'South Asian',
      amount: 'NPR 20,18,180.00',
      words: 'Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only',
    });
    expect(international).toMatchObject({
      value: 'international',
      name: 'International',
      amount: 'NPR 2,018,180.00',
      words: 'Two Million Eighteen Thousand One Hundred Eighty Rupees Only',
    });
  });

  it('writes each example in its own currency, whatever the other currencies use', () => {
    expect(numberSystemOptions('INR').map((o) => o.amount)).toEqual([
      'INR 20,18,180.00',
      'INR 2,018,180.00',
    ]);
    expect(numberSystemOptions('USD').map((o) => o.amount)).toEqual([
      'USD 20,18,180.00',
      'USD 2,018,180.00',
    ]);
    expect(numberSystemOptions('USD')[1]?.words).toMatch(/^Two Million .* Dollars Only$/);
  });
});

describe('numberSystemRows', () => {
  it('has one row per currency with the label the screen shows', () => {
    const rows = numberSystemRows();
    expect(rows.map((r) => r.currency)).toEqual(['NPR', 'INR', 'USD']);
    expect(rows.map((r) => r.label)).toEqual([
      'NPR (Nepalese rupee)',
      'INR (Indian rupee)',
      'USD (US dollar)',
    ]);
    expect(CURRENCY_LABELS.USD).toBe('USD (US dollar)');
    for (const row of rows) expect(row.options).toHaveLength(2);
  });
});

describe('parseNumberSystem and parseNumberSystems', () => {
  it('accepts the two systems and nothing else', () => {
    expect(parseNumberSystem('south_asian')).toBe('south_asian');
    expect(parseNumberSystem('international')).toBe('international');
    expect(parseNumberSystem('lakh')).toBeNull();
    expect(parseNumberSystem('')).toBeNull();
    expect(parseNumberSystem(undefined)).toBeNull();
  });

  it('reads the map only when every currency is valid and no other key is present', () => {
    expect(parseNumberSystems(DEFAULT_NUMBER_SYSTEMS)).toEqual(DEFAULT_NUMBER_SYSTEMS);
    expect(parseNumberSystems('south_asian')).toBeNull();
    expect(parseNumberSystems({ NPR: 'south_asian', INR: 'south_asian' })).toBeNull();
    expect(parseNumberSystems({ ...DEFAULT_NUMBER_SYSTEMS, EUR: 'international' })).toBeNull();
    expect(parseNumberSystems({ ...DEFAULT_NUMBER_SYSTEMS, USD: 'lakh' })).toBeNull();
  });
});

describe('numberSystemsFromForm', () => {
  const read = (values: Record<string, string>) => (field: string) => values[field];

  it('builds the map from the three currency fields', () => {
    expect(
      numberSystemsFromForm(
        read({
          [numberSystemFieldName('NPR')]: 'international',
          [numberSystemFieldName('INR')]: 'south_asian',
          [numberSystemFieldName('USD')]: 'south_asian',
        }),
      ),
    ).toEqual({ NPR: 'international', INR: 'south_asian', USD: 'south_asian' });
  });

  it('refuses a missing or invalid currency instead of filling it in', () => {
    expect(
      numberSystemsFromForm(
        read({ 'numberSystem:NPR': 'international', 'numberSystem:INR': 'south_asian' }),
      ),
    ).toBeNull();
    expect(
      numberSystemsFromForm(
        read({
          'numberSystem:NPR': 'lakh',
          'numberSystem:INR': 'south_asian',
          'numberSystem:USD': 'south_asian',
        }),
      ),
    ).toBeNull();
  });
});

describe('defaults per currency (D30)', () => {
  it('knows NPR and INR default to South Asian and USD to International', () => {
    expect(isDefaultNumberSystem('NPR', 'south_asian')).toBe(true);
    expect(isDefaultNumberSystem('INR', 'south_asian')).toBe(true);
    expect(isDefaultNumberSystem('USD', 'international')).toBe(true);
    expect(isDefaultNumberSystem('NPR', 'international')).toBe(false);
    expect(isDefaultNumberSystem('USD', 'south_asian')).toBe(false);
  });

  it('puts one currency back and leaves the others as they are', () => {
    const changed = { NPR: 'international', INR: 'international', USD: 'south_asian' } as const;
    expect(withCurrencyDefault(changed, 'INR')).toEqual({
      NPR: 'international',
      INR: 'south_asian',
      USD: 'south_asian',
    });
    expect(withCurrencyDefault(changed, 'USD')).toEqual({
      NPR: 'international',
      INR: 'international',
      USD: 'international',
    });
  });

  it('writes no key for a name that is not a currency', () => {
    const changed = { NPR: 'international', INR: 'international', USD: 'south_asian' } as const;
    const out = withCurrencyDefault(changed, 'toString' as never);
    expect(Object.keys(out).sort()).toEqual(['INR', 'NPR', 'USD']);
    expect(out).toEqual(changed);
  });

  it('compares two maps currency by currency', () => {
    expect(sameNumberSystems(DEFAULT_NUMBER_SYSTEMS, { ...DEFAULT_NUMBER_SYSTEMS })).toBe(true);
    expect(
      sameNumberSystems(DEFAULT_NUMBER_SYSTEMS, { ...DEFAULT_NUMBER_SYSTEMS, USD: 'south_asian' }),
    ).toBe(false);
  });
});

describe('pruneNumberDraft', () => {
  it('drops overrides that equal the saved choice and keeps the rest', () => {
    expect(
      pruneNumberDraft({ NPR: 'south_asian', USD: 'south_asian' }, DEFAULT_NUMBER_SYSTEMS),
    ).toEqual({
      USD: 'south_asian',
    });
  });

  it('returns the same object when there is nothing to drop', () => {
    const draft = { USD: 'south_asian' } as const;
    expect(pruneNumberDraft(draft, DEFAULT_NUMBER_SYSTEMS)).toBe(draft);
    const empty = {};
    expect(pruneNumberDraft(empty, DEFAULT_NUMBER_SYSTEMS)).toBe(empty);
  });
});

describe('date formats', () => {
  it('writes today in each of the four patterns, default first', () => {
    const options = dateFormatOptions('2026-11-19');
    expect(options.map((o) => o.example)).toEqual([
      '19 Nov 2026',
      '19/11/2026',
      '2026-11-19',
      'Nov 19, 2026',
    ]);
    expect(options[0]?.label).toBe('19 Nov 2026 (day month year)');
    expect(options[1]?.label).toBe('19/11/2026 (day/month/year)');
  });

  it('reads the default and refuses anything else', () => {
    expect(isDefaultDateFormat('dd MMM yyyy')).toBe(true);
    expect(isDefaultDateFormat('yyyy-MM-dd')).toBe(false);
    expect(defaultDateFormatText('2026-11-19')).toBe('19 Nov 2026');
    expect(parseDateFormat('yyyy-MM-dd')).toBe('yyyy-MM-dd');
    expect(parseDateFormat('dd-MM-yyyy')).toBeNull();
    expect(parseDateFormat(null)).toBeNull();
  });
});

describe('todayInKathmandu', () => {
  it('is the Kathmandu calendar day, which is ahead of UTC by 5h45', () => {
    expect(todayInKathmandu(new Date('2026-11-19T12:00:00Z'))).toBe('2026-11-19');
    // 18:30 UTC is 00:15 the next day in Kathmandu.
    expect(todayInKathmandu(new Date('2026-11-19T18:30:00Z'))).toBe('2026-11-20');
    expect(todayInKathmandu(new Date('2026-11-19T18:14:00Z'))).toBe('2026-11-19');
  });
});

describe('the loaded version', () => {
  it('reads the hidden field: empty means the page loaded the default', () => {
    expect(parseVersionField('')).toEqual({ ok: true, version: null });
    expect(parseVersionField('7')).toEqual({ ok: true, version: 7 });
    for (const bad of [null, undefined, '-1', '1.5', 'x', ' 3']) {
      expect(parseVersionField(bad)).toEqual({ ok: false });
    }
  });

  it('accepts an argument only when it is null or a whole number', () => {
    expect(isLoadedVersion(null)).toBe(true);
    expect(isLoadedVersion(0)).toBe(true);
    expect(isLoadedVersion(4)).toBe(true);
    for (const bad of [undefined, -1, 1.5, '4', Number.NaN])
      expect(isLoadedVersion(bad)).toBe(false);
  });
});
