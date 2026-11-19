import type { TermPreset } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  TERM_BODY_LIMITS,
  TERM_TAB_ORDER,
  firstLine,
  isTermKind,
  presetsOfKind,
  validatePreset,
} from './term-preset-model';

const preset = (n: number, kind: TermPreset['kind'], name: string): TermPreset => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind,
  name,
  body: `Body of ${name}`,
});

describe('presetsOfKind', () => {
  it('keeps one kind and sorts by name, ignoring case', () => {
    const list = [
      preset(1, 'scope', 'standard'),
      preset(2, 'exclusions', 'Anything'),
      preset(3, 'scope', 'Annual'),
      preset(4, 'scope', 'Zeta'),
    ];
    expect(presetsOfKind(list, 'scope').map((p) => p.name)).toEqual(['Annual', 'standard', 'Zeta']);
    expect(presetsOfKind(list, 'assumptions')).toEqual([]);
  });
});

describe('firstLine', () => {
  it('takes the first non-empty line and cuts a long one with an ellipsis', () => {
    expect(firstLine('\n  \nFifty percent advance\nthen the rest')).toBe('Fifty percent advance');
    expect(firstLine('')).toBe('');
    const cut = firstLine('x'.repeat(300), 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('validatePreset', () => {
  it('trims and accepts a name and text', () => {
    expect(validatePreset('scope', { name: '  Standard  ', body: ' Build it. ' })).toEqual({
      ok: true,
      value: { name: 'Standard', body: 'Build it.' },
    });
  });

  it('says what is missing at the field', () => {
    const result = validatePreset('scope', { name: '  ', body: '' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(Object.keys(result.fieldErrors).sort()).toEqual(['body', 'name']);
  });

  it('caps the name at 80 and the text at the kind limit (delivery timeline 2,000)', () => {
    expect(validatePreset('scope', { name: 'n'.repeat(81), body: 'ok' }).ok).toBe(false);
    expect(validatePreset('scope', { name: 'ok', body: 'b'.repeat(10_000) }).ok).toBe(true);
    expect(validatePreset('delivery_timeline', { name: 'ok', body: 'b'.repeat(2_000) }).ok).toBe(
      true,
    );
    const over = validatePreset('delivery_timeline', { name: 'ok', body: 'b'.repeat(2_001) });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.fieldErrors.body).toContain('2,000');
  });
});

describe('kinds', () => {
  it('has a tab and a limit for every kind the contract defines', () => {
    expect([...TERM_TAB_ORDER].sort()).toEqual(Object.keys(TERM_BODY_LIMITS).sort());
    expect(isTermKind('scope')).toBe(true);
    expect(isTermKind('constructor')).toBe(false);
    expect(isTermKind(7)).toBe(false);
  });
});
