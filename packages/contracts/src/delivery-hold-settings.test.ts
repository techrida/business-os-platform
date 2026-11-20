import { describe, expect, it } from 'vitest';

import {
  DELIVERY_HOLD_SETTING_DEFAULTS,
  SETTING_DEFAULTS,
  SETTINGS,
  SETTING_KEYS,
} from './settings.js';

describe('delivery-hold setting (F1-Q32, D32)', () => {
  const key = 'sales.delivery_hold.management_npr';

  it('is a setting key with the NPR 100,000 default', () => {
    expect(SETTING_KEYS).toContain(key);
    expect(DELIVERY_HOLD_SETTING_DEFAULTS).toEqual({ [key]: '100000' });
    expect(SETTING_DEFAULTS[key]).toBe('100000');
    expect(SETTINGS[key].safeParse(SETTING_DEFAULTS[key]).success).toBe(true);
  });

  it.each([
    ['0', true],
    ['100000.00', true],
    ['250000.5', true],
    ['-1', false],
    ['100000.123', false],
    ['1e5', false],
    ['', false],
  ])('validates %j as %s', (value, ok) => {
    expect(SETTINGS[key].safeParse(value).success).toBe(ok);
  });

  it('refuses a number: NPR amounts are decimal strings', () => {
    expect(SETTINGS[key].safeParse(100000).success).toBe(false);
  });
});
