// Unit tests of the pure convert rules: which stage may convert, and how duplicate candidates are merged.
import { describe, expect, it } from 'vitest';

import { mergeCandidates, planConvert } from './convert.rules';

describe('planConvert', () => {
  it('accepts a qualified lead at the version the caller saw', () => {
    expect(planConvert({ stage: 'qualified', version: 3, expectedVersion: 3 })).toEqual({
      ok: true,
    });
  });

  it('checks the version before the stage, so a stale caller is told the record changed', () => {
    const plan = planConvert({ stage: 'converted', version: 4, expectedVersion: 3 });
    expect(plan).toMatchObject({ ok: false, kind: 'stale' });
  });

  it('refuses every stage that has no edge to converted, and converted itself', () => {
    for (const stage of ['new', 'contacted', 'lost', 'on_hold', 'converted'] as const) {
      expect(planConvert({ stage, version: 2, expectedVersion: 2 }), stage).toMatchObject({
        ok: false,
        kind: 'not_convertible',
      });
    }
  });
});

describe('mergeCandidates', () => {
  it('joins what matched for one record and keeps the first-seen order', () => {
    const merged = mergeCandidates([
      { kind: 'contact', id: 'c1', label: 'Sita', matchedOn: 'email', customerId: 'k1' },
      { kind: 'customer', id: 'k1', label: 'Acme', matchedOn: 'name' },
      { kind: 'contact', id: 'c1', label: 'Sita', matchedOn: 'phone', customerId: 'k1' },
    ]);
    expect(merged).toEqual([
      { kind: 'contact', id: 'c1', label: 'Sita', matchedOn: 'email, phone', customerId: 'k1' },
      { kind: 'customer', id: 'k1', label: 'Acme', matchedOn: 'name' },
    ]);
  });

  it('keeps a customer and a contact that share an id apart, and cuts a long label to the wire limit', () => {
    const merged = mergeCandidates([
      { kind: 'customer', id: 'x', label: 'a'.repeat(400), matchedOn: 'name' },
      { kind: 'contact', id: 'x', label: 'B', matchedOn: 'email' },
    ]);
    expect(merged).toHaveLength(2);
    expect(merged[0]!.label).toHaveLength(300);
  });
});
