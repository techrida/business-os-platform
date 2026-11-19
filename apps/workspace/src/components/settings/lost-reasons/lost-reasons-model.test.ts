import { DEFAULT_LEAD_LOST_REASONS, type LeadLostReason } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { isDefaultList, labelProblem, movedOrder } from './lost-reasons-model';

const reason = (
  n: number,
  label: string,
  extra: Partial<LeadLostReason> = {},
): LeadLostReason => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  label,
  position: n,
  isDefault: true,
  retired: false,
  version: 1,
  ...extra,
});
const defaults = DEFAULT_LEAD_LOST_REASONS.map((d, i) => reason(i, d.label));

describe('labelProblem', () => {
  it('accepts a new label, trimmed', () => {
    expect(labelProblem('  Slow to reply ', defaults)).toBeNull();
  });

  it('refuses an empty label and one over the limit', () => {
    expect(labelProblem('   ', defaults)).toMatch(/Enter a name/);
    expect(labelProblem('x'.repeat(61), defaults)).toMatch(/60 characters/);
    expect(labelProblem('x'.repeat(60), defaults)).toBeNull();
  });

  it('refuses a duplicate in any case or spacing, naming the existing reason', () => {
    expect(labelProblem(' PRICE ', defaults)).toBe('"Price" is already on the list.');
  });

  it('points a duplicate of a retired reason at Restore', () => {
    const list = [reason(0, 'Price', { retired: true })];
    expect(labelProblem('price', list)).toMatch(/retired\. Restore it instead/);
  });

  it('lets an option keep its own words when renamed (only case or spacing changes)', () => {
    expect(labelProblem('PRICE', defaults, defaults[0]!.id)).toBeNull();
    expect(labelProblem('No budget', defaults, defaults[0]!.id)).toMatch(/already on the list/);
  });
});

describe('movedOrder', () => {
  const ids = defaults.map((r) => r.id);

  it('swaps with the neighbour', () => {
    expect(movedOrder(defaults, ids[2]!, 'up').slice(0, 3)).toEqual([ids[0], ids[2], ids[1]]);
    expect(movedOrder(defaults, ids[0]!, 'down').slice(0, 3)).toEqual([ids[1], ids[0], ids[2]]);
  });

  it('stays put at either end and for an unknown id', () => {
    expect(movedOrder(defaults, ids[0]!, 'up')).toEqual(ids);
    expect(movedOrder(defaults, ids[6]!, 'down')).toEqual(ids);
    expect(movedOrder(defaults, 'nope', 'up')).toEqual(ids);
  });

  it('orders by position, whatever order the list arrives in', () => {
    const shuffled = [defaults[3]!, defaults[0]!, defaults[2]!, defaults[1]!];
    expect(movedOrder(shuffled, defaults[1]!.id, 'up')).toEqual([
      defaults[1]!.id,
      defaults[0]!.id,
      defaults[2]!.id,
      defaults[3]!.id,
    ]);
  });
});

describe('isDefaultList', () => {
  it('is true for the shipped list', () => {
    expect(isDefaultList(defaults)).toBe(true);
  });

  it('is false after a rename, a retire, a reorder or an added option', () => {
    expect(isDefaultList([reason(0, 'Cost'), ...defaults.slice(1)])).toBe(false);
    expect(isDefaultList([{ ...defaults[0]!, retired: true }, ...defaults.slice(1)])).toBe(false);
    expect(
      isDefaultList([
        { ...defaults[0]!, position: 1 },
        { ...defaults[1]!, position: 0 },
        ...defaults.slice(2),
      ]),
    ).toBe(false);
    expect(isDefaultList([...defaults, reason(7, 'Slow', { isDefault: false })])).toBe(false);
  });
});
