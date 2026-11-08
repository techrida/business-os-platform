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

describe('parseSettingInput: the P2 keys', () => {
  it.each(['fx.max_rate_age_days', 'quotation.validity_days'] as const)(
    'parses %s as a strict whole number',
    (key) => {
      expect(parseSettingInput(key, [' 7 '])).toEqual({ ok: true, value: 7 });
      expect(parseSettingInput(key, ['365'])).toEqual({ ok: true, value: 365 });
      expect(parseSettingInput(key, ['007'])).toEqual({ ok: true, value: 7 });
      for (const bad of ['7.5', '1e1', '07x', '', ' ', '-1', '+7', '0x10', '0', '366']) {
        expect(parseSettingInput(key, [bad]).ok, JSON.stringify(bad)).toBe(false);
      }
      expect(parseSettingInput(key, []).ok).toBe(false);
    },
  );

  it('accepts only the four evidence policies', () => {
    for (const ok of ['contract', 'purchase_order', 'both', 'signed_quote']) {
      expect(parseSettingInput('sales.evidence_policy', [ok])).toEqual({ ok: true, value: ok });
    }
    expect(parseSettingInput('sales.evidence_policy', ['po']).ok).toBe(false);
    expect(parseSettingInput('sales.evidence_policy', ['']).ok).toBe(false);
  });
});

describe('settingValueText', () => {
  it('prints strings, string lists and objects', () => {
    expect(settingValueText('13')).toBe('13');
    expect(settingValueText(['NPR', 'INR'])).toBe('NPR, INR');
    expect(settingValueText({ a: 1 })).toBe('{\n  "a": 1\n}');
  });
});

describe('parseSettingInput: the selling entity', () => {
  it('turns an empty PAN/VAT field into null and checks the shape of a number', () => {
    expect(parseSettingInput('entity.pan_vat_no', [' 301234567 '])).toEqual({
      ok: true,
      value: '301234567',
    });
    expect(parseSettingInput('entity.pan_vat_no', [''])).toEqual({ ok: true, value: null });
    expect(parseSettingInput('entity.pan_vat_no', ['  '])).toEqual({ ok: true, value: null });
    expect(parseSettingInput('entity.pan_vat_no', ['12 34']).ok).toBe(false);
  });

  it('parses the address from JSON, an empty field is null, a bad one is refused', () => {
    const address = { line1: 'Kupondole', city: 'Lalitpur', country: 'NP' };
    expect(parseSettingInput('entity.address', [JSON.stringify(address)])).toEqual({
      ok: true,
      value: address,
    });
    expect(parseSettingInput('entity.address', [''])).toEqual({ ok: true, value: null });
    expect(parseSettingInput('entity.address', ['{']).ok).toBe(false);
    expect(parseSettingInput('entity.address', ['{"city":"Lalitpur","country":"NP"}']).ok).toBe(
      false,
    );
  });

  it('shows an unset value as an empty field, not the word null', () => {
    expect(settingValueText(null)).toBe('');
  });
});
