import type { TermPreset } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { canFillSilently, offeredPresets, pickOutcome } from './saved-options';

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
