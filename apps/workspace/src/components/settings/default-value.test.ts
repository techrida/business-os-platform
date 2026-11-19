import { SETTING_DEFAULTS, SETTING_KEYS } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { defaultText, isDefaultValue } from './default-value';

describe('isDefaultValue', () => {
  it('is true for the default of every setting', () => {
    for (const key of SETTING_KEYS)
      expect(isDefaultValue(key, SETTING_DEFAULTS[key]), key).toBe(true);
  });

  it('is false for a saved value the schema refuses', () => {
    expect(isDefaultValue('tax.vat_rate', 'abc')).toBe(false);
    expect(isDefaultValue('numbering.memo_prefix', null)).toBe(false);
    expect(isDefaultValue('quotation.validity_days', '15')).toBe(false);
  });

  it('compares scalars: a changed prefix, day count and policy are not the default', () => {
    expect(isDefaultValue('numbering.memo_prefix', 'MEMO')).toBe(true);
    expect(isDefaultValue('numbering.memo_prefix', 'MEMOS')).toBe(false);
    expect(isDefaultValue('quotation.validity_days', 15)).toBe(true);
    expect(isDefaultValue('quotation.validity_days', 30)).toBe(false);
    expect(isDefaultValue('sales.evidence_policy', 'signed_quote')).toBe(true);
    expect(isDefaultValue('sales.evidence_policy', 'both')).toBe(false);
  });

  it('reads decimal strings by value, not by spelling', () => {
    expect(isDefaultValue('tax.vat_rate', '13')).toBe(true);
    expect(isDefaultValue('tax.vat_rate', '13.00')).toBe(true);
    expect(isDefaultValue('tax.vat_rate', '13.5')).toBe(false);
    expect(isDefaultValue('procurement.match.qty_pct', '0.0')).toBe(true);
    expect(isDefaultValue('procurement.match.price_npr', '500.00')).toBe(true);
    expect(isDefaultValue('procurement.match.price_npr', '501')).toBe(false);
  });

  it('treats the enabled currencies as a set and refuses a different set', () => {
    expect(isDefaultValue('currency.enabled', ['NPR', 'INR', 'USD'])).toBe(true);
    expect(isDefaultValue('currency.enabled', ['NPR', 'USD', 'INR'])).toBe(true);
    expect(isDefaultValue('currency.enabled', ['NPR', 'USD'])).toBe(false);
    expect(isDefaultValue('currency.enabled', ['NPR'])).toBe(false);
    // Not valid (NPR missing): never the default.
    expect(isDefaultValue('currency.enabled', ['INR', 'USD'])).toBe(false);
  });

  it('compares the reminder object whatever its key order, and fills the schema defaults', () => {
    expect(
      isDefaultValue('approvals.sla_defaults', {
        escalateTo: { role: 'founder' },
        escalateAfterHours: 72,
        remindAfterHours: 24,
      }),
    ).toBe(true);
    expect(isDefaultValue('approvals.sla_defaults', {})).toBe(true);
    expect(
      isDefaultValue('approvals.sla_defaults', {
        remindAfterHours: 12,
        escalateAfterHours: 72,
        escalateTo: { role: 'founder' },
      }),
    ).toBe(false);
    expect(
      isDefaultValue('approvals.sla_defaults', {
        remindAfterHours: 24,
        escalateAfterHours: 72,
        escalateTo: { role: 'management' },
      }),
    ).toBe(false);
  });

  it('compares the billing schedule in order and by row content', () => {
    const [advance, milestone, final] = SETTING_DEFAULTS['sales.default_schedule'];
    expect(isDefaultValue('sales.default_schedule', [advance, milestone, final])).toBe(true);
    expect(isDefaultValue('sales.default_schedule', [milestone, advance, final])).toBe(false);
    expect(
      isDefaultValue('sales.default_schedule', [
        { ...advance!, percent: '60.0' },
        milestone,
        final,
      ]),
    ).toBe(true);
    expect(
      isDefaultValue('sales.default_schedule', [
        { label: 'Advance 50%', percent: '50', trigger: 'advance' },
        { label: 'Final 50%', percent: '50', trigger: 'uat' },
      ]),
    ).toBe(false);
  });

  it('tells a set value from an unset one (null defaults)', () => {
    expect(isDefaultValue('entity.pan_vat_no', null)).toBe(true);
    expect(isDefaultValue('entity.pan_vat_no', '123456789')).toBe(false);
  });
});

describe('defaultText', () => {
  it('reads each default in plain words', () => {
    expect(defaultText('tax.vat_rate')).toBe('13');
    expect(defaultText('numbering.memo_prefix')).toBe('MEMO');
    expect(defaultText('quotation.validity_days')).toBe('15');
    expect(defaultText('currency.enabled')).toBe('NPR, INR, USD');
    expect(defaultText('approvals.sla_defaults')).toBe(
      'remind after 24 h, escalate after 72 h to founder',
    );
    expect(defaultText('sales.default_schedule')).toBe('Advance 60%, Milestone 20%, Final 20%');
    expect(defaultText('entity.pan_vat_no')).toBe('none');
  });

  it('keeps a long default short enough for a tooltip', () => {
    for (const key of SETTING_KEYS) expect(defaultText(key).length, key).toBeLessThanOrEqual(90);
  });
});
