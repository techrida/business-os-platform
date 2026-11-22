import { describe, expect, it } from 'vitest';

import {
  EVIDENCE_KINDS,
  EVIDENCE_POLICIES,
  P2_SETTING_DEFAULTS,
  SETTING_KEYS,
  SETTINGS,
} from './index.js';

describe('P2 settings', () => {
  it('lists the three new keys', () => {
    for (const key of [
      'fx.max_rate_age_days',
      'quotation.validity_days',
      'sales.evidence_policy',
      'entity.pan_vat_no',
      'entity.address',
    ]) {
      expect(SETTING_KEYS).toContain(key);
    }
  });

  it('exports defaults that satisfy their own schemas', () => {
    expect(P2_SETTING_DEFAULTS).toEqual({
      'fx.max_rate_age_days': 7,
      'quotation.validity_days': 15,
      'sales.evidence_policy': 'signed_quote',
      'entity.pan_vat_no': null,
      'entity.address': null,
    });
    for (const key of Object.keys(P2_SETTING_DEFAULTS) as (keyof typeof P2_SETTING_DEFAULTS)[]) {
      expect(SETTINGS[key].safeParse(P2_SETTING_DEFAULTS[key]).success, key).toBe(true);
    }
  });

  it.each([
    ['fx.max_rate_age_days', 1, true],
    ['fx.max_rate_age_days', 365, true],
    ['fx.max_rate_age_days', 0, false],
    ['fx.max_rate_age_days', -1, false],
    ['fx.max_rate_age_days', 366, false],
    ['fx.max_rate_age_days', 1.5, false],
    ['fx.max_rate_age_days', '7', false],
    ['quotation.validity_days', 15, true],
    ['quotation.validity_days', 0, false],
    ['quotation.validity_days', 366, false],
    ['quotation.validity_days', 2.5, false],
    ['quotation.validity_days', null, false],
  ] as const)('%s accepts %j: %s', (key, value, ok) => {
    expect(SETTINGS[key].safeParse(value).success).toBe(ok);
  });

  describe('the selling entity', () => {
    const address = { line: 'Kupondole', city: 'Lalitpur', country: 'NP' };

    it.each([
      ['entity.pan_vat_no', '301234567', true],
      ['entity.pan_vat_no', null, true],
      ['entity.pan_vat_no', '', false],
      ['entity.pan_vat_no', 'no spaces allowed', false],
      ['entity.address', address, true],
      ['entity.address', null, true],
      ['entity.address', { ...address, country: 'Nepal' }, false],
      ['entity.address', { ...address, extra: 'x' }, false],
      ['entity.address', { city: 'Lalitpur', country: 'NP' }, false],
      ['entity.address', { line: 'Kupondole', city: 'Lalitpur' }, false],
      ['entity.address', { line1: 'Kupondole', city: 'Lalitpur', country: 'NP' }, false],
    ] as const)('%s accepts %j: %s', (key, value, ok) => {
      expect(SETTINGS[key].safeParse(value).success).toBe(ok);
    });
  });

  it.each(['contract', 'purchase_order', 'both', 'signed_quote'])(
    'accepts evidence policy %s',
    (v) => {
      expect(SETTINGS['sales.evidence_policy'].safeParse(v).success).toBe(true);
    },
  );

  it('builds the policy from the evidence kinds plus both, so the two cannot drift', () => {
    expect([...EVIDENCE_POLICIES]).toEqual([...EVIDENCE_KINDS, 'both']);
  });

  it.each(['', 'none', 'po', 'PO', 'contract,purchase_order', 7, null])(
    'rejects evidence policy %j',
    (v) => {
      expect(SETTINGS['sales.evidence_policy'].safeParse(v).success).toBe(false);
    },
  );
});
