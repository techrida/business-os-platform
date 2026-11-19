import { DEFAULT_TERM_PRESETS, type TermPreset } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  TERM_BODY_LIMITS,
  TERM_TAB_ORDER,
  isAppDefaultSet,
  isTermKind,
  normalizeBody,
  presetsOfKind,
  previewLine,
  termSetsAreDefault,
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

describe('previewLine', () => {
  it('turns rich text into one line of plain words, list markers dropped', () => {
    expect(
      previewLine(
        '<p><strong>Website</strong> terms</p><ul><li>Half up front</li><li>Rest later</li></ul>',
      ),
    ).toBe('Website terms · Half up front · Rest later');
    expect(previewLine('<ol><li>First</li><li>Second</li></ol>')).toBe('First · Second');
  });

  it('shows legacy plain text as it is, on one line', () => {
    expect(previewLine('\n  \nFifty percent advance\nthen the rest')).toBe(
      'Fifty percent advance · then the rest',
    );
    expect(previewLine('')).toBe('');
  });

  it('never shows markup or a script, and cuts a long text with an ellipsis', () => {
    expect(previewLine('<p>Hi</p><script>alert(1)</script>')).toBe('Hi');
    const cut = previewLine(`<p>${'x'.repeat(300)}</p>`, 20);
    expect(cut).toHaveLength(20);
    expect(cut.endsWith('…')).toBe(true);
  });
});

describe('app default sets', () => {
  it('knows the ids the app ships with, and no others', () => {
    for (const d of DEFAULT_TERM_PRESETS) expect(isAppDefaultSet(d.id)).toBe(true);
    expect(isAppDefaultSet('00000000-0000-4000-8000-000000000001')).toBe(false);
  });

  it('is at the default only when the list is exactly the defaults, in any order', () => {
    expect(termSetsAreDefault(DEFAULT_TERM_PRESETS)).toBe(true);
    expect(termSetsAreDefault([...DEFAULT_TERM_PRESETS].reverse())).toBe(true);
    expect(termSetsAreDefault([])).toBe(false);
    expect(termSetsAreDefault(DEFAULT_TERM_PRESETS.slice(1))).toBe(false);
    expect(termSetsAreDefault([...DEFAULT_TERM_PRESETS, preset(9, 'scope', 'Mine')])).toBe(false);
    const [first, ...rest] = DEFAULT_TERM_PRESETS;
    expect(
      termSetsAreDefault([{ ...(first as TermPreset), body: '<p>Changed</p>' }, ...rest]),
    ).toBe(false);
  });
});

describe('normalizeBody', () => {
  it('rebuilds rich text from the allow-list and only trims plain text', () => {
    expect(normalizeBody('<p onclick="x()">Hi</p><script>y()</script>')).toBe('<p>Hi</p>');
    expect(normalizeBody('  Net 30  ')).toBe('Net 30');
  });
});

describe('validatePreset', () => {
  it('trims and accepts a name and text', () => {
    expect(validatePreset('scope', { name: '  Standard  ', body: ' Build it. ' })).toEqual({
      ok: true,
      value: { name: 'Standard', body: 'Build it.' },
    });
  });

  it('sanitises rich text and keeps plain text plain', () => {
    expect(
      validatePreset('scope', { name: 'a', body: '<p>Hi <em>there</em></p><script>x()</script>' }),
    ).toEqual({ ok: true, value: { name: 'a', body: '<p>Hi <em>there</em></p>' } });
  });

  it('counts words, not markup, and treats markup without words as empty', () => {
    const body = `<p><strong>${'b'.repeat(2_000)}</strong></p>`;
    expect(validatePreset('delivery_timeline', { name: 'ok', body }).ok).toBe(true);
    expect(
      validatePreset('delivery_timeline', {
        name: 'ok',
        body: body.replace('</strong>', 'b</strong>'),
      }).ok,
    ).toBe(false);
    for (const empty of ['<p></p>', '<p> </p>', '<ul><li></li></ul>']) {
      const result = validatePreset('scope', { name: 'ok', body: empty });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.fieldErrors.body).toContain('Write the text');
    }
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
