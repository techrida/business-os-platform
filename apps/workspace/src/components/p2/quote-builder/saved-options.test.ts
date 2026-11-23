import type { TermPreset } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  canFillSilently,
  defaultPreset,
  offeredPresets,
  pickOutcome,
  pickerState,
  withDefaultTerms,
} from './saved-options';

const make = (n: number, kind: TermPreset['kind'], name: string, body: string): TermPreset => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
  kind,
  name,
  body,
});
const a = make(1, 'scope', 'Standard build', 'We build it.');
const b = make(2, 'scope', 'Annual support', 'We support it for a year.');
const other = make(3, 'exclusions', 'Hardware', 'No hardware.');
const long = make(4, 'delivery_timeline', 'Long', 'x'.repeat(2_001));
const all = [a, b, other, long];

describe('offeredPresets', () => {
  it('keeps the kind, sorts by name and drops what the field could not hold', () => {
    expect(offeredPresets(all, 'scope', 10_000).map((p) => p.name)).toEqual([
      'Annual support',
      'Standard build',
    ]);
    expect(offeredPresets(all, 'delivery_timeline', 2_000)).toEqual([]);
    expect(offeredPresets(all, 'delivery_timeline', 10_000)).toEqual([long]);
  });

  it('counts the words of a rich text body, not its markup, against the field limit', () => {
    const html = make(
      5,
      'delivery_timeline',
      'Marked up',
      `<p><strong>${'x'.repeat(1_990)}</strong></p>`,
    );
    expect(offeredPresets([html], 'delivery_timeline', 2_000)).toEqual([html]);
    const over = make(6, 'delivery_timeline', 'Over', `<p><em>${'x'.repeat(2_001)}</em></p>`);
    expect(offeredPresets([over], 'delivery_timeline', 2_000)).toEqual([]);
  });

  it('offers nothing when the presets are missing or failed to load', () => {
    expect(offeredPresets(null, 'scope', 10)).toEqual([]);
    expect(offeredPresets(undefined, 'scope', 10)).toEqual([]);
  });
});

describe('canFillSilently', () => {
  const offered = offeredPresets(all, 'scope', 10_000);

  it('fills an empty or blank field', () => {
    expect(canFillSilently('', null, offered)).toBe(true);
    expect(canFillSilently('  \n', null, offered)).toBe(true);
  });

  it('fills over the text of the last fill, and over the text of any saved option', () => {
    expect(canFillSilently(a.body, a.body, offered)).toBe(true);
    expect(canFillSilently(b.body, null, offered)).toBe(true);
  });

  it('asks once the field was edited since the last fill, or holds text nobody filled', () => {
    expect(canFillSilently(`${a.body} Plus extras.`, a.body, offered)).toBe(false);
    expect(canFillSilently('Typed by hand', null, offered)).toBe(false);
    expect(canFillSilently('Typed by hand', a.body, offered)).toBe(false);
  });
});

describe('canFillSilently on rich text', () => {
  const rich = make(7, 'scope', 'Rich', '<p>We build it.</p><ul><li>Phase one</li></ul>');
  const offered = offeredPresets([rich, a], 'scope', 10_000);

  it('treats the editor rewriting a set as untouched: same words, different markup', () => {
    expect(
      canFillSilently('<p>We build it.</p><ul><li>Phase one</li></ul>', rich.body, offered),
    ).toBe(true);
    expect(
      canFillSilently('<p>We build it.</p>\n<ul>\n<li>Phase one</li>\n</ul>', rich.body, offered),
    ).toBe(true);
    // A plain-text set the editor re-emitted as a paragraph.
    expect(canFillSilently('<p>We build it.</p>', a.body, offered)).toBe(true);
  });

  it('fills over an editor that holds only empty paragraphs', () => {
    expect(canFillSilently('<p></p>', null, offered)).toBe(true);
  });

  it('asks once the words changed', () => {
    expect(
      canFillSilently('<p>We build it. Later.</p><ul><li>Phase one</li></ul>', rich.body, offered),
    ).toBe(false);
  });
});

describe('pickOutcome', () => {
  const offered = offeredPresets(all, 'scope', 10_000);

  it('ignores the empty choice and an unknown id', () => {
    expect(pickOutcome('', offered, '', null)).toEqual({ action: 'ignore' });
    expect(pickOutcome('nope', offered, '', null)).toEqual({ action: 'ignore' });
  });

  it('fills an empty field and asks before replacing typed text', () => {
    expect(pickOutcome(a.id, offered, '', null)).toEqual({ action: 'fill', preset: a });
    expect(pickOutcome(b.id, offered, 'My own scope', a.body)).toEqual({
      action: 'confirm',
      preset: b,
    });
  });

  it('does not offer an option of another kind', () => {
    expect(pickOutcome(other.id, offered, '', null)).toEqual({ action: 'ignore' });
  });
});

describe('pickerState', () => {
  const scope = [a, b];
  it('is empty for blank text, the preset for its words (markup and spacing aside), else custom', () => {
    expect(pickerState('', scope, null)).toEqual({ state: 'empty' });
    expect(pickerState('<p> </p>', scope, null)).toEqual({ state: 'empty' });
    expect(pickerState('<p>We   build\nit.</p>', scope, null)).toEqual({
      state: 'preset',
      preset: a,
    });
    expect(pickerState('We build it. More.', scope, a.id)).toEqual({ state: 'custom' });
  });
  it('prefers the last applied one when two presets hold the same words', () => {
    const twin = make(9, 'scope', 'Twin', a.body);
    expect(pickerState(a.body, [a, twin], twin.id)).toEqual({ state: 'preset', preset: twin });
    expect(pickerState(a.body, [a, twin], null)).toEqual({ state: 'preset', preset: a });
  });
});

describe('defaultPreset', () => {
  it('is the kind default that fits the field, and nothing when none is set', () => {
    const d = { ...b, isDefault: true };
    expect(defaultPreset([a, d, other], 'scope', 10_000)).toEqual(d);
    expect(defaultPreset([a, b], 'scope', 10_000)).toBeUndefined();
    expect(defaultPreset([{ ...other, isDefault: true }], 'scope', 10_000)).toBeUndefined();
    expect(defaultPreset([{ ...b, isDefault: true }], 'scope', 5)).toBeUndefined();
    expect(defaultPreset(null, 'scope', 10_000)).toBeUndefined();
  });
});

describe('withDefaultTerms', () => {
  const blank = {
    scope: '',
    assumptions: '',
    exclusions: '',
    deliveryTimeline: '',
    termsAndConditions: '',
  };
  it('fills each empty field with its kind default and leaves the others empty', () => {
    const scopeDefault = { ...a, isDefault: true };
    const terms = { ...make(7, 'terms_conditions', 'Std terms', 'Net 30.'), isDefault: true };
    expect(withDefaultTerms(blank, [scopeDefault, b, terms])).toEqual({
      ...blank,
      scope: a.body,
      termsAndConditions: 'Net 30.',
    });
    expect(withDefaultTerms(blank, [a, b])).toEqual(blank);
    expect(withDefaultTerms(blank, null)).toEqual(blank);
    expect(withDefaultTerms({ ...blank, scope: 'typed' }, [scopeDefault]).scope).toBe('typed');
  });
});
