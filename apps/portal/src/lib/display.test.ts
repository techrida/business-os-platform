import { describe, expect, it } from 'vitest';

import { DEFAULT_PORTAL_DISPLAY, displayFormat, taxLineLabel } from './display';

describe('displayFormat', () => {
  it('draws the defaults without a setting: lakh for NPR, international for USD, 23 Nov 2026', () => {
    const { money, day } = displayFormat();
    expect(money('2018180', 'NPR')).toBe('NPR 20,18,180.00');
    expect(money('2018180', 'USD')).toBe('USD 2,018,180.00');
    expect(day('2026-11-19')).toBe('19 Nov 2026');
    expect(DEFAULT_PORTAL_DISPLAY.dateFormat).toBe('dd MMM yyyy');
  });

  it('follows the per-currency number system and the date pattern it is given', () => {
    const { money, day } = displayFormat({
      numberSystems: { NPR: 'international', INR: 'international', USD: 'south_asian' },
      dateFormat: 'MMM dd, yyyy',
    });
    expect(money('2018180', 'NPR')).toBe('NPR 2,018,180.00');
    expect(money('2018180', 'USD')).toBe('USD 20,18,180.00');
    expect(day('2026-11-19')).toBe('Nov 19, 2026');
    // Not a calendar date (a legacy milestone wording): passes through as written.
    expect(day('On order')).toBe('On order');
  });
});

describe('taxLineLabel', () => {
  it('adds the rate only when the label does not already show it', () => {
    expect(taxLineLabel('VAT 13%', '13')).toBe('VAT 13%');
    expect(taxLineLabel('VAT', '13')).toBe('VAT 13%');
    // 13% in the label is not 3%: the real rate must still show.
    expect(taxLineLabel('VAT 13%', '3')).toBe('VAT 13% 3%');
    expect(taxLineLabel('VAT 2.5%', '5')).toBe('VAT 2.5% 5%');
    expect(taxLineLabel('VAT', '13.0000')).toBe('VAT 13%');
    expect(taxLineLabel('Service charge 10%', '10.5')).toBe('Service charge 10% 10.5%');
  });
});
