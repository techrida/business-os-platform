import type { AdminDepartmentDetail } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import {
  addPeople,
  buildDepartmentChanges,
  filterPeople,
  headOf,
  initialPeopleState,
  keepPerson,
  movePeople,
  recordNotices,
  removePeople,
  setHead,
  setJobTitle,
  setLevel,
  setLevelMany,
} from './people-model';

const SALES = '00000000-0000-4000-8000-0000000000d1';
const MARKETING = '00000000-0000-4000-8000-0000000000d2';
const ASHA = '00000000-0000-4000-8000-0000000000a1';
const BIBEK = '00000000-0000-4000-8000-0000000000b2';
const CHANDRA = '00000000-0000-4000-8000-0000000000c3';
const DIPA = '00000000-0000-4000-8000-0000000000e4';

const member = (userId: string, name: string, level: 'staff' | 'manager' | 'head') => ({
  userId,
  name,
  email: `${name.split(' ')[0]?.toLowerCase()}@example.test`,
  jobTitle: null,
  level,
  roles: ['sales' as const],
  since: '2026-01-04T00:00:00.000Z',
});

const detail: AdminDepartmentDetail = {
  id: SALES,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: { id: ASHA, name: 'Asha K.' },
  managers: 0,
  memberCount: 3,
  members: [
    member(ASHA, 'Asha K.', 'head'),
    member(BIBEK, 'Bibek R.', 'staff'),
    member(CHANDRA, 'Chandra T.', 'staff'),
  ],
  version: 3,
  revision: '12',
};

const initial = initialPeopleState(detail);
const levels = (state: ReturnType<typeof initialPeopleState>) =>
  Object.fromEntries(state.people.map((p) => [p.name, p.level]));

describe('one head, or none', () => {
  it('makes the previous head a manager when another member is set to Head', () => {
    const next = setLevel(initial, BIBEK, 'head');
    expect(levels(next)).toEqual({ 'Asha K.': 'manager', 'Bibek R.': 'head', 'Chandra T.': 'staff' });
    expect(headOf(next)?.userId).toBe(BIBEK);
  });

  it('keeps the Head field and the Level column in step', () => {
    const viaField = setHead(initial, BIBEK);
    expect(viaField).toEqual(setLevel(initial, BIBEK, 'head'));
    const cleared = setHead(initial, null);
    expect(headOf(cleared)).toBeNull();
    expect(levels(cleared)['Asha K.']).toBe('manager');
  });

  it('leaves the department with no head when the head is removed', () => {
    expect(headOf(removePeople(initial, [ASHA]))).toBeNull();
  });

  it('brings a removed head back as a manager once someone else leads', () => {
    const next = keepPerson(setHead(removePeople(initial, [ASHA]), BIBEK), ASHA);
    expect(headOf(next)?.userId).toBe(BIBEK);
    expect(levels(next)['Asha K.']).toBe('manager');
  });
});

describe('buildDepartmentChanges', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildDepartmentChanges(initial, initial)).toEqual([]);
    expect(buildDepartmentChanges(initial, setJobTitle(initial, BIBEK, '   '))).toEqual([]);
  });

  it('sends a head change, never the demotion the server adds itself', () => {
    expect(buildDepartmentChanges(initial, setLevel(initial, BIBEK, 'head'))).toEqual([
      { kind: 'head', departmentId: SALES, userId: BIBEK },
    ]);
  });

  it('sends a level change for a former head who should become staff', () => {
    const staged = setLevel(setLevel(initial, BIBEK, 'head'), ASHA, 'staff');
    expect(buildDepartmentChanges(initial, staged)).toEqual([
      { kind: 'head', departmentId: SALES, userId: BIBEK },
      { kind: 'memberLevel', departmentId: SALES, userId: ASHA, level: 'staff' },
    ]);
  });

  it('clears the head only while the old head stays', () => {
    expect(buildDepartmentChanges(initial, setHead(initial, null))).toEqual([
      { kind: 'head', departmentId: SALES, userId: null },
    ]);
    expect(buildDepartmentChanges(initial, removePeople(initial, [ASHA]))).toEqual([
      { kind: 'memberRemove', departmentId: SALES, userId: ASHA },
    ]);
  });

  it('adds a person from another department as a join here, with level and job title', () => {
    const added = addPeople(initial, [
      {
        id: DIPA,
        name: 'Dipa S.',
        email: null,
        roles: ['marketing'],
        department: { id: MARKETING, name: 'Marketing' },
      },
    ]);
    const staged = setJobTitle(setLevel(added, DIPA, 'manager'), DIPA, ' Field lead ');
    expect(staged.people.at(-1)?.fromDepartment).toEqual({ id: MARKETING, name: 'Marketing' });
    expect(buildDepartmentChanges(initial, staged)).toEqual([
      {
        kind: 'memberAdd',
        departmentId: SALES,
        userId: DIPA,
        level: 'manager',
        jobTitle: 'Field lead',
      },
    ]);
  });

  it('lets an added person become head through the join alone', () => {
    const staged = setHead(
      addPeople(initial, [{ id: DIPA, name: 'Dipa S.', email: null, roles: [], department: null }]),
      DIPA,
    );
    expect(buildDepartmentChanges(initial, staged)).toEqual([
      { kind: 'memberAdd', departmentId: SALES, userId: DIPA, level: 'head' },
    ]);
  });

  it('orders leaving, joining, head, levels and job titles', () => {
    let staged = movePeople(initial, [CHANDRA], { id: MARKETING, name: 'Marketing' });
    staged = addPeople(staged, [{ id: DIPA, name: 'Dipa S.', email: null, roles: [], department: null }]);
    staged = setHead(staged, BIBEK);
    staged = setLevel(staged, ASHA, 'staff');
    staged = setJobTitle(staged, BIBEK, 'Head of sales');
    expect(buildDepartmentChanges(initial, staged).map((c) => c.kind)).toEqual([
      'memberMove',
      'memberAdd',
      'head',
      'memberLevel',
      'memberJobTitle',
    ]);
    expect(buildDepartmentChanges(initial, staged)[0]).toEqual({
      kind: 'memberMove',
      userId: CHANDRA,
      fromDepartmentId: SALES,
      toDepartmentId: MARKETING,
    });
  });

  it('drops a person added in this edit instead of removing them', () => {
    const added = addPeople(initial, [
      { id: DIPA, name: 'Dipa S.', email: null, roles: [], department: null },
    ]);
    const staged = removePeople(added, [DIPA]);
    expect(staged.people.map((p) => p.userId)).toEqual([ASHA, BIBEK, CHANDRA]);
    expect(buildDepartmentChanges(initial, staged)).toEqual([]);
  });

  it('never offers Head in bulk and sets the others together', () => {
    const staged = setLevelMany(initial, [BIBEK, CHANDRA], 'manager');
    expect(buildDepartmentChanges(initial, staged)).toEqual([
      { kind: 'memberLevel', departmentId: SALES, userId: BIBEK, level: 'manager' },
      { kind: 'memberLevel', departmentId: SALES, userId: CHANDRA, level: 'manager' },
    ]);
  });
});

describe('notices and filters', () => {
  it('says where owned records stay for joins, moves and removals', () => {
    let staged = addPeople(initial, [
      {
        id: DIPA,
        name: 'Dipa S.',
        email: null,
        roles: [],
        department: { id: MARKETING, name: 'Marketing' },
      },
    ]);
    staged = movePeople(staged, [CHANDRA], { id: MARKETING, name: 'Marketing' });
    staged = removePeople(staged, [BIBEK]);
    expect(recordNotices(staged)).toEqual([
      'Records Bibek R. owns stay with them and stay under Sales.',
      'Records Chandra T. owns stay with Sales. Reassign them if Marketing should have them.',
      'Records Dipa S. owns stay with Marketing. Reassign them if Sales should have them.',
    ]);
  });

  it('filters members by search text and level', () => {
    expect(filterPeople(initial.people, 'bib', []).map((p) => p.name)).toEqual(['Bibek R.']);
    expect(filterPeople(initial.people, '', ['head']).map((p) => p.name)).toEqual(['Asha K.']);
    expect(filterPeople(initial.people, 'zzz', [])).toEqual([]);
  });
});
