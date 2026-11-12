import type { MemoDirectory } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { layoutOptions } from '@/components/ui/combobox-model';

import { approverChoices, staffOptions, STAFF_GROUPING_THRESHOLD } from './staff-picker';

type Person = MemoDirectory['people'][number];
const guid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const person = (n: number, over: Partial<Person> = {}): Person => ({
  userId: guid(n),
  name: `Staff ${String(n).padStart(2, '0')}`,
  jobTitle: n % 2 ? 'Accountant' : null,
  department: n % 3 === 0 ? 'Finance' : 'Operations',
  canApprove: true,
  ...over,
});
const team = (count: number) => Array.from({ length: count }, (_, i) => person(i + 1));

describe('staffOptions', () => {
  it('maps real directory fields: id, name, title and department', () => {
    const [first] = staffOptions([person(1, { department: 'Finance' })]);
    expect(first).toMatchObject({
      id: guid(1),
      label: 'Staff 01',
      group: 'Finance',
      description: 'Accountant · Finance',
    });
  });

  it('keeps the department in the line for a flat list and leaves it to the heading in a grouped one', () => {
    const flat = staffOptions(team(STAFF_GROUPING_THRESHOLD));
    expect(flat[2]!.description ?? '').toContain('Finance');
    const grouped = staffOptions(team(STAFF_GROUPING_THRESHOLD + 1));
    expect(grouped[2]!.description ?? '').not.toContain('Finance');
  });

  it('tells two people with one name apart by title, else by a short reference', () => {
    const [a, b] = staffOptions([
      person(1, { name: 'Ram Thapa', jobTitle: 'Accountant' }),
      person(2, { name: 'Ram Thapa', jobTitle: null }),
    ]);
    expect(a!.label).toBe('Ram Thapa (Accountant)');
    expect(b!.label).toBe(`Ram Thapa (ref ${guid(2).slice(-8)})`);
  });

  it('shows people chosen in another row but does not let them be chosen again', () => {
    const [a, b] = staffOptions(team(2), { disabledIds: new Set([guid(1)]) });
    expect(a).toMatchObject({ disabled: true, disabledReason: 'Already chosen' });
    expect(b!.disabled).toBeUndefined();
  });

  it('handles Unicode names', () => {
    const [a] = staffOptions([person(1, { name: 'सुशील श्रेष्ठ' })]);
    expect(layoutOptions([a!], 'श्रेष्ठ').flat).toHaveLength(1);
  });

  it('lists at most 20 staff flat and more than 20 under their real departments', () => {
    expect(layoutOptions(staffOptions(team(20)), '', STAFF_GROUPING_THRESHOLD).grouped).toBe(false);
    const grouped = layoutOptions(staffOptions(team(21)), '', STAFF_GROUPING_THRESHOLD);
    expect(grouped.grouped).toBe(true);
    expect(grouped.groups.map((g) => g.label)).toEqual(['Finance', 'Operations']);
  });
});

describe('approverChoices', () => {
  const people = [
    person(1, { name: 'Approver', canApprove: true }),
    person(2, { name: 'Sales', canApprove: false }),
    person(3, { name: 'Saved but lost the right', canApprove: false }),
  ];

  it('offers only people who can decide approvals', () => {
    expect(approverChoices(people, '').map((p) => p.name)).toEqual(['Approver']);
  });

  it('keeps the person already in the field so a saved memo still shows their name', () => {
    expect(approverChoices(people, guid(3)).map((p) => p.name)).toEqual([
      'Approver',
      'Saved but lost the right',
    ]);
  });

  it('is empty when nobody holds approval rights, so the field can say so', () => {
    expect(approverChoices(people.slice(1, 2), '')).toEqual([]);
  });
});
