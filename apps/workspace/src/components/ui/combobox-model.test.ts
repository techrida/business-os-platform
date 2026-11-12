import { describe, expect, it } from 'vitest';

import {
  layoutOptions,
  matchesQuery,
  moveActive,
  resultsAnnouncement,
  selectableIds,
  type ComboboxOption,
} from './combobox-model';

const person = (
  n: number,
  group: string | null,
  extra: Partial<ComboboxOption> = {},
): ComboboxOption => ({
  id: `id-${String(n).padStart(3, '0')}`,
  label: `Person ${String(n).padStart(2, '0')}`,
  description: n % 2 ? 'Accountant' : 'Finance Manager',
  group,
  ...extra,
});

const many = (count: number, groups: Array<string | null>): ComboboxOption[] =>
  Array.from({ length: count }, (_, i) => person(i + 1, groups[i % groups.length]!));

describe('matchesQuery', () => {
  const o: ComboboxOption = {
    id: '1',
    label: 'Sushil Shrestha',
    description: 'Accountant',
    group: 'Finance',
  };
  it('matches every word anywhere in name, description or group, ignoring case', () => {
    expect(matchesQuery(o, '')).toBe(true);
    expect(matchesQuery(o, 'sush acc')).toBe(true);
    expect(matchesQuery(o, 'FINANCE shrest')).toBe(true);
    expect(matchesQuery(o, 'sushil ram')).toBe(false);
  });
  it('matches Unicode names, composed or not', () => {
    const jose: ComboboxOption = { id: '2', label: 'José Ñandú' };
    expect(matchesQuery(jose, 'josé')).toBe(true);
    expect(matchesQuery({ id: '3', label: 'सुशील श्रेष्ठ' }, 'श्रेष्ठ')).toBe(true);
  });
});

describe('layoutOptions', () => {
  it('keeps 20 or fewer people flat, sorted by name', () => {
    const layout = layoutOptions(many(20, ['Finance', 'Sales']), '');
    expect(layout.grouped).toBe(false);
    expect(layout.groups).toHaveLength(1);
    expect(layout.groups[0]!.label).toBeNull();
    expect(layout.flat.map((o) => o.label)).toEqual([...layout.flat.map((o) => o.label)].sort());
  });

  it('groups more than 20 people by their real department, Unassigned last', () => {
    const layout = layoutOptions(many(21, ['Sales', 'Finance', null]), '');
    expect(layout.grouped).toBe(true);
    expect(layout.groups.map((g) => g.label)).toEqual(['Finance', 'Sales', 'Unassigned']);
    expect(layout.flat).toHaveLength(21);
  });

  it('decides grouping on the whole list, so typing never changes the list shape', () => {
    const layout = layoutOptions(many(25, ['Finance', 'Sales']), 'Person 01');
    expect(layout.grouped).toBe(true);
    expect(layout.flat.map((o) => o.label)).toEqual(['Person 01']);
    expect(layout.groups).toHaveLength(1);
  });

  it('hides empty groups and reports no matches as an empty layout', () => {
    expect(layoutOptions(many(25, ['Finance', 'Sales']), 'zzz')).toMatchObject({
      groups: [],
      flat: [],
    });
    expect(layoutOptions([], '')).toMatchObject({ groups: [], flat: [], grouped: false });
  });

  it('does not mutate its input', () => {
    const input = many(5, ['A']);
    const copy = [...input];
    layoutOptions(input, 'Person');
    expect(input).toEqual(copy);
  });
});

describe('keyboard movement', () => {
  const ids = ['a', 'b', 'c'];
  it('moves through the selectable ids and wraps at both ends', () => {
    expect(moveActive(ids, null, 'ArrowDown')).toBe('a');
    expect(moveActive(ids, null, 'ArrowUp')).toBe('c');
    expect(moveActive(ids, 'a', 'ArrowDown')).toBe('b');
    expect(moveActive(ids, 'c', 'ArrowDown')).toBe('a');
    expect(moveActive(ids, 'a', 'ArrowUp')).toBe('c');
    expect(moveActive(ids, 'gone', 'ArrowDown')).toBe('a');
    expect(moveActive([], 'a', 'ArrowDown')).toBeNull();
  });

  it('skips options that cannot be selected', () => {
    const flat: ComboboxOption[] = [
      { id: 'a', label: 'A' },
      { id: 'b', label: 'B', disabled: true },
      { id: 'c', label: 'C' },
    ];
    expect(selectableIds(flat)).toEqual(['a', 'c']);
    expect(moveActive(selectableIds(flat), 'a', 'ArrowDown')).toBe('c');
  });
});

describe('resultsAnnouncement', () => {
  const texts = { empty: 'No staff members are available.', noMatch: 'No matching staff members.' };
  it('says the empty, no-match and count cases in words', () => {
    expect(resultsAnnouncement(0, 0, texts)).toBe(texts.empty);
    expect(resultsAnnouncement(0, 7, texts)).toBe(texts.noMatch);
    expect(resultsAnnouncement(1, 7, texts)).toBe('1 result available');
    expect(resultsAnnouncement(3, 7, texts)).toBe('3 results available');
  });
});
