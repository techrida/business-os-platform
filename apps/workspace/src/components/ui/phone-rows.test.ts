import { describe, expect, it } from 'vitest';

import { postedPhoneRowIndexes, rawPhoneRows } from './phone-rows';

const formData = (entries: [string, string][]) => {
  const form = new FormData();
  for (const [key, value] of entries) form.append(key, value);
  return form;
};

const row = (i: number, number: string, country = 'NP', label = '', isPrimary = 'false') =>
  [
    [`phones.${i}.number`, number],
    [`phones.${i}.country`, country],
    [`phones.${i}.label`, label],
    [`phones.${i}.isPrimary`, isPrimary],
  ] as [string, string][];

describe('rawPhoneRows', () => {
  it('reads each row with a number, trimmed and otherwise as posted, and leaves blank rows out', () => {
    const form = formData([
      ...row(0, ' +9779812345678 ', ' np ', ' mobile ', 'true'),
      ...row(1, '   '),
      ...row(2, '+14155552671', 'US', 'work'),
    ]);
    expect(rawPhoneRows(form, 'phones')).toEqual([
      { row: 0, country: 'np', number: '+9779812345678', label: 'mobile', isPrimary: true },
      { row: 2, country: 'US', number: '+14155552671', label: 'work', isPrimary: false },
    ]);
  });

  it('does not move the primary flag when it sits on a blank row', () => {
    const form = formData([...row(0, '', 'NP', '', 'true'), ...row(1, '+14155552671', 'US')]);
    expect(rawPhoneRows(form, 'phones')).toEqual([
      { row: 1, country: 'US', number: '+14155552671', label: '', isPrimary: false },
    ]);
  });

  it('stops at the first row with no number field, and at the limit', () => {
    const gap = formData([...row(0, '+9779812345678'), ...row(2, '+14155552671', 'US')]);
    expect(rawPhoneRows(gap, 'phones').map((r) => r.row)).toEqual([0]);

    const many = formData(
      Array.from({ length: 21 }, (_, i) =>
        row(i, `+97798123456${String(i).padStart(2, '0')}`),
      ).flat(),
    );
    expect(rawPhoneRows(many, 'phones', { limit: 20 })).toHaveLength(20);
    expect(rawPhoneRows(many, 'phones')).toHaveLength(21);
  });

  it('reads only the rows it is given, skipping one with no number', () => {
    const gap = formData([
      ['phones.0.country', 'NP'],
      ...row(2, '+14155552671', 'US'),
      ...row(5, '+9779812345678'),
    ]);
    expect(postedPhoneRowIndexes(gap, 'phones')).toEqual([0, 2, 5]);
    expect(rawPhoneRows(gap, 'phones', { rows: postedPhoneRowIndexes(gap, 'phones') })).toEqual([
      { row: 2, country: 'US', number: '+14155552671', label: '', isPrimary: false },
      { row: 5, country: 'NP', number: '+9779812345678', label: '', isPrimary: false },
    ]);
  });

  it('finds row positions only under its own name', () => {
    const form = formData([
      ...row(1, '+9779812345678'),
      ['contactPhones.0.number', '+14155552671'],
      ['phones.3.other', 'x'],
      ['phones.x.number', 'x'],
    ]);
    expect(postedPhoneRowIndexes(form, 'phones')).toEqual([1]);
  });

  it('reads a plain object with only get', () => {
    const entries: Record<string, string> = Object.fromEntries(
      row(0, '+9779812345678', 'NP', 'home'),
    );
    const form = { get: (name: string) => entries[name] ?? null };
    expect(rawPhoneRows(form, 'phones')).toEqual([
      { row: 0, country: 'NP', number: '+9779812345678', label: 'home', isPrimary: false },
    ]);
  });

  it('skips a number that is not text', () => {
    const form = new FormData();
    form.append('phones.0.number', new Blob(['x']), 'x.txt');
    for (const [key, value] of row(1, '+9779812345678')) form.append(key, value);
    expect(rawPhoneRows(form, 'phones').map((r) => r.row)).toEqual([1]);
  });
});
