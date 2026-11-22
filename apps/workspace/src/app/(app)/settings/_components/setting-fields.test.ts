import { describe, expect, it } from 'vitest';

import { SETTING_COPY, settingLabel } from './setting-fields';

describe('setting labels', () => {
  it('names a percent setting without % because its box shows the sign', () => {
    for (const entry of Object.values(SETTING_COPY)) {
      if (entry?.kind === 'percent') expect(entry.label).not.toContain('%');
    }
    expect(settingLabel('procurement.match.qty_pct')).toBe('Quantity tolerance');
    expect(settingLabel('procurement.match.price_pct')).toBe('Price tolerance');
  });

  it('keeps NPR and days on labels whose plain box shows no unit', () => {
    expect(settingLabel('procurement.match.price_npr')).toBe('Price tolerance (NPR)');
    expect(settingLabel('quotation.validity_days')).toBe('Quotation validity (days)');
  });
});
