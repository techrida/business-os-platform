import { describe, expect, it } from 'vitest';

import { scheduleSummary } from './setting-fields';
import { isFieldAtDefault, parseSettingInput, settingValueText } from './setting-input';

describe('parseSettingInput (legacy raw string arrays)', () => {
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

describe('parseSettingInput (typed SettingFieldValue)', () => {
  it('serialises typed SLA defaults and rejects escalate <= remind or non-integers', () => {
    expect(
      parseSettingInput('approvals.sla_defaults', {
        kind: 'sla',
        value: { remindAfterHours: '12', escalateAfterHours: '48', escalateToRole: 'management' },
      }),
    ).toEqual({
      ok: true,
      value: { remindAfterHours: 12, escalateAfterHours: 48, escalateTo: { role: 'management' } },
    });

    const badOrder = parseSettingInput('approvals.sla_defaults', {
      kind: 'sla',
      value: { remindAfterHours: '72', escalateAfterHours: '24', escalateToRole: 'founder' },
    });
    expect(badOrder.ok).toBe(false);
    expect(badOrder.ok === false && badOrder.message).toContain('later than remind after');

    expect(
      parseSettingInput('approvals.sla_defaults', {
        kind: 'sla',
        value: { remindAfterHours: '2.5', escalateAfterHours: '24', escalateToRole: 'founder' },
      }).ok,
    ).toBe(false);
  });

  it('serialises typed billing schedule rows and reports exact shortfall or excess', () => {
    expect(
      parseSettingInput('sales.default_schedule', {
        kind: 'schedule',
        rows: [
          { label: '  Advance  ', percent: '33.33', trigger: 'advance' },
          { label: 'Milestone', percent: '33.33', trigger: 'milestone' },
          { label: 'Final', percent: '33.34', trigger: 'uat' },
        ],
      }),
    ).toEqual({
      ok: true,
      value: [
        { label: 'Advance', percent: '33.33', trigger: 'advance' },
        { label: 'Milestone', percent: '33.33', trigger: 'milestone' },
        { label: 'Final', percent: '33.34', trigger: 'uat' },
      ],
    });

    const short = parseSettingInput('sales.default_schedule', {
      kind: 'schedule',
      rows: [
        { label: 'Advance', percent: '60', trigger: 'advance' },
        { label: 'Final', percent: '20', trigger: 'uat' },
      ],
    });
    expect(short.ok).toBe(false);
    expect(short.ok === false && short.message).toContain('Add 20% more');

    const over = parseSettingInput('sales.default_schedule', {
      kind: 'schedule',
      rows: [
        { label: 'Advance', percent: '60', trigger: 'advance' },
        { label: 'Final', percent: '45', trigger: 'uat' },
      ],
    });
    expect(over.ok).toBe(false);
    expect(over.ok === false && over.message).toContain('Remove 5%');

    const emptyLabel = parseSettingInput('sales.default_schedule', {
      kind: 'schedule',
      rows: [{ label: '   ', percent: '100', trigger: 'advance' }],
    });
    expect(emptyLabel.ok).toBe(false);
  });

  it('rejects VAT with > 2 decimals and checks numeric ranges on typed inputs', () => {
    expect(parseSettingInput('tax.vat_rate', { kind: 'text', value: '13.25' })).toEqual({
      ok: true,
      value: '13.25',
    });
    expect(parseSettingInput('tax.vat_rate', { kind: 'text', value: '100.123' }).ok).toBe(false);
    expect(parseSettingInput('tax.vat_rate', { kind: 'text', value: '101' }).ok).toBe(false);
    expect(parseSettingInput('fx.max_rate_age_days', { kind: 'text', value: '366' }).ok).toBe(
      false,
    );
    expect(parseSettingInput('quotation.validity_days', { kind: 'text', value: '0' }).ok).toBe(
      false,
    );
    expect(parseSettingInput('procurement.min_quotes', { kind: 'text', value: '11' }).ok).toBe(
      false,
    );
    expect(parseSettingInput('currency.enabled', { kind: 'currencies', values: ['USD'] }).ok).toBe(
      false,
    );
  });

  it('computes exact schedule totals without floating-point drift', () => {
    expect(
      scheduleSummary([
        { label: 'A', percent: '33.33', trigger: 'advance' },
        { label: 'B', percent: '33.33', trigger: 'milestone' },
        { label: 'C', percent: '33.34', trigger: 'uat' },
      ]),
    ).toEqual({ status: 'ok', totalText: '100' });

    expect(scheduleSummary([{ label: 'A', percent: '80', trigger: 'advance' }])).toEqual({
      status: 'short',
      totalText: '80',
      diffText: '20',
      actionText: 'Add 20% more',
    });

    expect(scheduleSummary([{ label: 'A', percent: '105', trigger: 'advance' }])).toMatchObject({
      status: 'invalid',
    });
  });

  it('treats equivalent decimals and reordered currency sets as matching default', () => {
    expect(isFieldAtDefault('tax.vat_rate', { kind: 'text', value: '13.00' })).toBe(true);
    expect(isFieldAtDefault('tax.vat_rate', { kind: 'text', value: '14' })).toBe(false);
    expect(
      isFieldAtDefault('currency.enabled', { kind: 'currencies', values: ['USD', 'NPR', 'INR'] }),
    ).toBe(true);
    expect(
      isFieldAtDefault('currency.enabled', { kind: 'currencies', values: ['NPR', 'USD'] }),
    ).toBe(false);
  });
});

describe('parseSettingInput: the P4 procurement keys', () => {
  it('parses procurement.min_quotes as a strict whole number from 1 to 10', () => {
    const key = 'procurement.min_quotes';
    expect(parseSettingInput(key, [' 3 '])).toEqual({ ok: true, value: 3 });
    expect(parseSettingInput(key, ['10'])).toEqual({ ok: true, value: 10 });
    for (const bad of ['2.5', '1e1', '', '-1', '0', '11', '0x3']) {
      expect(parseSettingInput(key, [bad]).ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it('keeps the decimal-string keys as plain text, checked by the shared schema', () => {
    expect(parseSettingInput('procurement.match.price_pct', [' 2.5 '])).toEqual({
      ok: true,
      value: '2.5',
    });
    expect(parseSettingInput('procurement.match.price_pct', ['101']).ok).toBe(false);
    expect(parseSettingInput('procurement.band.founder_npr', ['1000000'])).toEqual({
      ok: true,
      value: '1000000',
    });
    expect(parseSettingInput('procurement.band.founder_npr', ['-1']).ok).toBe(false);
  });
});

describe('parseSettingInput: the delivery-hold threshold (F1-Q32)', () => {
  const key = 'sales.delivery_hold.management_npr';
  const MONEY_MESSAGE = 'Enter an amount of 0 or more with up to two decimal places.';

  it('keeps a typed amount of 0 or more with up to two decimals as exact text', () => {
    expect(parseSettingInput(key, { kind: 'text', value: ' 250000.50 ' })).toEqual({
      ok: true,
      value: '250000.50',
    });
    expect(parseSettingInput(key, { kind: 'text', value: '0' })).toEqual({ ok: true, value: '0' });
  });

  it.each(['-1', '100000.123', '1e5', '', 'abc'])(
    'refuses %j with the money sentence, not the schema text',
    (bad) => {
      expect(parseSettingInput(key, { kind: 'text', value: bad })).toEqual({
        ok: false,
        message: MONEY_MESSAGE,
      });
    },
  );

  it('knows the NPR 100,000 default', () => {
    expect(isFieldAtDefault(key, { kind: 'text', value: '100000' })).toBe(true);
    expect(isFieldAtDefault(key, { kind: 'text', value: '150000' })).toBe(false);
  });
});

describe('parseSettingInput: the default lead owner (F1-Q21)', () => {
  const key = 'crm.default_lead_owner';
  const PERSON = '3f0c5a52-7c2e-4d0b-9a55-0e8d1d6a3b11';

  it('saves the picked person as their user id', () => {
    expect(parseSettingInput(key, { kind: 'text', value: PERSON })).toEqual({
      ok: true,
      value: PERSON,
    });
  });

  it('saves the empty choice as null, which is the Sales head and the default', () => {
    expect(parseSettingInput(key, { kind: 'text', value: '' })).toEqual({ ok: true, value: null });
    expect(isFieldAtDefault(key, { kind: 'text', value: '' })).toBe(true);
    expect(isFieldAtDefault(key, { kind: 'text', value: PERSON })).toBe(false);
  });

  it('refuses anything that is not a user id with a plain sentence', () => {
    expect(parseSettingInput(key, { kind: 'text', value: 'sita' })).toEqual({
      ok: false,
      message: 'Choose a person from the list.',
    });
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
    const address = { line: 'Kupondole', city: 'Lalitpur', country: 'NP' };
    expect(parseSettingInput('entity.address', [JSON.stringify(address)])).toEqual({
      ok: true,
      value: address,
    });
    expect(parseSettingInput('entity.address', [''])).toEqual({ ok: true, value: null });
    expect(parseSettingInput('entity.address', ['{']).ok).toBe(false);
    expect(parseSettingInput('entity.address', ['{"city":"Lalitpur","country":"NP"}']).ok).toBe(
      false,
    );
    // The pre-FX9 shape (line1) and an address without its country are refused.
    expect(
      parseSettingInput('entity.address', [
        '{"line1":"Kupondole","city":"Lalitpur","country":"NP"}',
      ]).ok,
    ).toBe(false);
    expect(parseSettingInput('entity.address', ['{"line":"Kupondole","city":"Lalitpur"}']).ok).toBe(
      false,
    );
  });

  it('shows an unset value as an empty field, not the word null', () => {
    expect(settingValueText(null)).toBe('');
  });
});
