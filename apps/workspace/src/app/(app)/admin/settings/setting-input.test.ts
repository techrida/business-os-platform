import { describe, expect, it } from 'vitest';

import { parseSettingInput, settingValueText } from './setting-input';

describe('parseSettingInput', () => {
  it('trims a VAT rate and rejects one out of range', () => {
    expect(parseSettingInput('tax.vat_rate', [' 13 '])).toEqual({ ok: true, value: '13' });
    expect(parseSettingInput('tax.vat_rate', ['101']).ok).toBe(false);
    expect(parseSettingInput('tax.vat_rate', ['abc']).ok).toBe(false);
  });

  it('keeps NPR enabled and refuses an empty currency list', () => {
    expect(parseSettingInput('currency.enabled', ['NPR', 'USD'])).toEqual({
      ok: true,
      value: ['NPR', 'USD'],
    });
    const noNpr = parseSettingInput('currency.enabled', ['USD']);
    expect(noNpr.ok).toBe(false);
    expect(noNpr.ok === false && noNpr.message).toContain('NPR');
    expect(parseSettingInput('currency.enabled', []).ok).toBe(false);
  });

  it('checks the memo prefix pattern', () => {
    expect(parseSettingInput('numbering.memo_prefix', ['MEMO'])).toEqual({
      ok: true,
      value: 'MEMO',
    });
    expect(parseSettingInput('numbering.memo_prefix', ['memo']).ok).toBe(false);
  });

  it('parses SLA defaults from JSON and fills the schema defaults', () => {
    const out = parseSettingInput('approvals.sla_defaults', [
      '{"remindAfterHours":12,"escalateAfterHours":48,"escalateTo":{"role":"management"}}',
    ]);
    expect(out).toEqual({
      ok: true,
      value: { remindAfterHours: 12, escalateAfterHours: 48, escalateTo: { role: 'management' } },
    });
    expect(parseSettingInput('approvals.sla_defaults', ['{']).ok).toBe(false);
    expect(
      parseSettingInput('approvals.sla_defaults', [
        '{"remindAfterHours":50,"escalateAfterHours":10}',
      ]).ok,
    ).toBe(false);
  });
});

describe('settingValueText', () => {
  it('prints strings, string lists and objects', () => {
    expect(settingValueText('13')).toBe('13');
    expect(settingValueText(['NPR', 'INR'])).toBe('NPR, INR');
    expect(settingValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});
