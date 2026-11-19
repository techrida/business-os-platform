import { describe, expect, it } from 'vitest';

import {
  applyDepartmentChanges,
  DepartmentChangeValidationError,
  describeDepartmentChanges,
  type DepartmentSnapshot,
} from './department-changes';

const SALES_ID = '11111111-1111-4111-8111-111111111111';
const MARKETING_ID = '22222222-2222-4222-8222-222222222222';
const RETIRED_ID = '33333333-3333-4333-8333-333333333333';

const ASHA_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const BIKASH_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NISHA_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const DIPAK_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const INACTIVE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const OUTSIDER_ID = 'ffffffff-ffff-4fff-8fff-ffffffffffff';

function makeSnapshot(): DepartmentSnapshot {
  return {
    departments: [
      { id: SALES_ID, name: 'Sales', status: 'active', headUserId: ASHA_ID },
      { id: MARKETING_ID, name: 'Marketing', status: 'active', headUserId: NISHA_ID },
      { id: RETIRED_ID, name: 'Legacy Ops', status: 'retired', headUserId: null },
    ],
    people: [
      {
        userId: ASHA_ID,
        name: 'Asha Thapa',
        active: true,
        departmentId: SALES_ID,
        level: 'head',
        jobTitle: 'VP Sales',
      },
      {
        userId: BIKASH_ID,
        name: 'Bikash Rai',
        active: true,
        departmentId: SALES_ID,
        level: 'staff',
        jobTitle: 'Account Executive',
      },
      {
        userId: NISHA_ID,
        name: 'Nisha Gurung',
        active: true,
        departmentId: MARKETING_ID,
        level: 'head',
        jobTitle: 'Marketing Lead',
      },
      {
        userId: DIPAK_ID,
        name: 'Dipak Shrestha',
        active: true,
        departmentId: null,
        level: 'staff',
        jobTitle: null,
      },
      {
        userId: INACTIVE_ID,
        name: 'Former Staff',
        active: false,
        departmentId: null,
        level: 'staff',
        jobTitle: null,
      },
    ],
  };
}

describe('applyDepartmentChanges and describeDepartmentChanges', () => {
  it('does not mutate the input snapshot', () => {
    const snapshot = makeSnapshot();
    const copy = structuredClone(snapshot);

    const res = applyDepartmentChanges(snapshot, [
      { kind: 'head', departmentId: SALES_ID, userId: BIKASH_ID },
      { kind: 'memberAdd', departmentId: SALES_ID, userId: DIPAK_ID, jobTitle: 'SDR' },
    ]);

    expect(res.ok).toBe(true);
    expect(snapshot).toEqual(copy);
  });

  it('switches department head via head change and surfaces the previous head demotion as alsoChanges', () => {
    const snapshot = makeSnapshot();
    const res = applyDepartmentChanges(snapshot, [
      { kind: 'head', departmentId: SALES_ID, userId: BIKASH_ID },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const sales = res.next.departments.find((d) => d.id === SALES_ID);
    const asha = res.next.people.find((p) => p.userId === ASHA_ID);
    const bikash = res.next.people.find((p) => p.userId === BIKASH_ID);
    expect(sales?.headUserId).toBe(BIKASH_ID);
    expect(bikash?.level).toBe('head');
    expect(asha?.level).toBe('manager');

    expect(res.effects).toEqual([
      {
        kind: 'head',
        summary: 'Bikash Rai becomes head of Sales',
        alsoChanges: false,
        departmentId: SALES_ID,
        userId: BIKASH_ID,
      },
      {
        kind: 'headDemoted',
        summary: 'Asha Thapa becomes a manager in Sales',
        alsoChanges: true,
        departmentId: SALES_ID,
        userId: ASHA_ID,
      },
    ]);
    expect(res.auditEntries.map((e) => e.action)).toEqual([
      'department.head.changed',
      'department.member.level_changed',
    ]);
  });

  it('switches department head via memberLevel head and describes the automatic demotion', () => {
    const effects = describeDepartmentChanges(makeSnapshot(), [
      { kind: 'memberLevel', departmentId: SALES_ID, userId: BIKASH_ID, level: 'head' },
    ]);

    expect(effects).toHaveLength(2);
    expect(effects[0]).toMatchObject({
      kind: 'memberLevel',
      alsoChanges: false,
      summary: 'Bikash Rai becomes head of Sales',
    });
    expect(effects[1]).toMatchObject({
      kind: 'headDemoted',
      alsoChanges: true,
      userId: ASHA_ID,
      summary: 'Asha Thapa becomes a manager in Sales',
    });
  });

  it('clears the department head and demotes the outgoing head to manager', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'head', departmentId: SALES_ID, userId: null },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.departments.find((d) => d.id === SALES_ID)?.headUserId).toBeNull();
    expect(res.next.people.find((p) => p.userId === ASHA_ID)?.level).toBe('manager');
    expect(res.effects).toEqual([
      {
        kind: 'head',
        summary: 'Clear head of Sales',
        alsoChanges: false,
        departmentId: SALES_ID,
        userId: null,
      },
      {
        kind: 'headDemoted',
        summary: 'Asha Thapa becomes a manager in Sales',
        alsoChanges: true,
        departmentId: SALES_ID,
        userId: ASHA_ID,
      },
    ]);
  });

  it('clears department head when the head is demoted via memberLevel', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'memberLevel', departmentId: SALES_ID, userId: ASHA_ID, level: 'manager' },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.departments.find((d) => d.id === SALES_ID)?.headUserId).toBeNull();
    expect(res.next.people.find((p) => p.userId === ASHA_ID)?.level).toBe('manager');
    expect(res.effects.some((e) => e.kind === 'head' && e.alsoChanges && e.userId === null)).toBe(
      true,
    );
  });

  it('adds an unassigned person and allows promoting them to head in the same batch', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'memberAdd', departmentId: SALES_ID, userId: DIPAK_ID, jobTitle: 'Sales Lead' },
      { kind: 'head', departmentId: SALES_ID, userId: DIPAK_ID },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    const dipak = res.next.people.find((p) => p.userId === DIPAK_ID);
    const asha = res.next.people.find((p) => p.userId === ASHA_ID);
    const sales = res.next.departments.find((d) => d.id === SALES_ID);
    expect(dipak).toMatchObject({
      departmentId: SALES_ID,
      level: 'head',
      jobTitle: 'Sales Lead',
    });
    expect(asha?.level).toBe('manager');
    expect(sales?.headUserId).toBe(DIPAK_ID);
  });

  it('treats memberAdd of someone in another department as a move and demotes a moved head to manager', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'memberAdd', departmentId: SALES_ID, userId: NISHA_ID },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.departments.find((d) => d.id === MARKETING_ID)?.headUserId).toBeNull();
    // Sales keeps Asha as head because Nisha moved without level='head'.
    expect(res.next.departments.find((d) => d.id === SALES_ID)?.headUserId).toBe(ASHA_ID);
    expect(res.next.people.find((p) => p.userId === NISHA_ID)).toMatchObject({
      departmentId: SALES_ID,
      level: 'manager',
    });
    expect(res.effects[0]).toMatchObject({
      kind: 'memberMove',
      alsoChanges: false,
      departmentId: SALES_ID,
      fromDepartmentId: MARKETING_ID,
      userId: NISHA_ID,
    });
    expect(res.effects.some((e) => e.alsoChanges && e.departmentId === MARKETING_ID)).toBe(true);
  });

  it('moves a department head via memberMove without overwriting the destination head', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      {
        kind: 'memberMove',
        userId: NISHA_ID,
        fromDepartmentId: MARKETING_ID,
        toDepartmentId: SALES_ID,
      },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.departments.find((d) => d.id === MARKETING_ID)?.headUserId).toBeNull();
    expect(res.next.departments.find((d) => d.id === SALES_ID)?.headUserId).toBe(ASHA_ID);
    expect(res.next.people.find((p) => p.userId === NISHA_ID)).toMatchObject({
      departmentId: SALES_ID,
      level: 'manager',
    });
    expect(res.auditEntries.map((e) => e.action)).toEqual([
      'department.member.moved',
      'department.head.changed',
    ]);
  });

  it('removes a head cleanly, resetting their level to staff and clearing the department head', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'memberRemove', departmentId: SALES_ID, userId: ASHA_ID },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.departments.find((d) => d.id === SALES_ID)?.headUserId).toBeNull();
    expect(res.next.people.find((p) => p.userId === ASHA_ID)).toMatchObject({
      departmentId: null,
      level: 'staff',
    });
    expect(res.effects).toEqual([
      {
        kind: 'memberRemove',
        summary: 'Asha Thapa leaves Sales',
        alsoChanges: false,
        departmentId: SALES_ID,
        userId: ASHA_ID,
      },
      {
        kind: 'head',
        summary: 'Sales will have no head',
        alsoChanges: true,
        departmentId: SALES_ID,
        userId: null,
      },
    ]);
  });

  it('updates and clears job titles and skips no-op edits', () => {
    const res = applyDepartmentChanges(makeSnapshot(), [
      { kind: 'memberJobTitle', departmentId: SALES_ID, userId: BIKASH_ID, jobTitle: '  Senior AE  ' },
      { kind: 'memberJobTitle', departmentId: SALES_ID, userId: BIKASH_ID, jobTitle: 'Senior AE' },
      { kind: 'memberJobTitle', departmentId: SALES_ID, userId: ASHA_ID, jobTitle: '   ' },
    ]);

    expect(res.ok).toBe(true);
    if (!res.ok) return;

    expect(res.next.people.find((p) => p.userId === BIKASH_ID)?.jobTitle).toBe('Senior AE');
    expect(res.next.people.find((p) => p.userId === ASHA_ID)?.jobTitle).toBeNull();
    expect(res.effects).toHaveLength(2);
    expect(res.auditEntries.map((e) => e.action)).toEqual([
      'department.member.job_title_changed',
      'department.member.job_title_changed',
    ]);
  });

  it('rejects invalid operations with structured failures and throws from describeDepartmentChanges', () => {
    const snapshot = makeSnapshot();

    const retiredAdd = applyDepartmentChanges(snapshot, [
      { kind: 'memberAdd', departmentId: RETIRED_ID, userId: DIPAK_ID },
    ]);
    expect(retiredAdd).toMatchObject({ ok: false, error: { code: 'department_retired' } });

    const inactiveAdd = applyDepartmentChanges(snapshot, [
      { kind: 'memberAdd', departmentId: SALES_ID, userId: INACTIVE_ID },
    ]);
    expect(inactiveAdd).toMatchObject({ ok: false, error: { code: 'person_inactive' } });

    const outsiderAdd = applyDepartmentChanges(snapshot, [
      { kind: 'memberAdd', departmentId: SALES_ID, userId: OUTSIDER_ID },
    ]);
    expect(outsiderAdd).toMatchObject({ ok: false, error: { code: 'person_not_found' } });

    const alreadyMember = applyDepartmentChanges(snapshot, [
      { kind: 'memberAdd', departmentId: SALES_ID, userId: BIKASH_ID },
    ]);
    expect(alreadyMember).toMatchObject({ ok: false, error: { code: 'already_a_member' } });

    const sameDeptMove = applyDepartmentChanges(snapshot, [
      { kind: 'memberMove', userId: BIKASH_ID, fromDepartmentId: SALES_ID, toDepartmentId: SALES_ID },
    ]);
    expect(sameDeptMove).toMatchObject({ ok: false, error: { code: 'same_department_move' } });

    const wrongSourceMove = applyDepartmentChanges(snapshot, [
      {
        kind: 'memberMove',
        userId: BIKASH_ID,
        fromDepartmentId: MARKETING_ID,
        toDepartmentId: SALES_ID,
      },
    ]);
    expect(wrongSourceMove).toMatchObject({
      ok: false,
      error: { code: 'source_department_mismatch' },
    });

    const nonMemberHead = applyDepartmentChanges(snapshot, [
      { kind: 'head', departmentId: SALES_ID, userId: DIPAK_ID },
    ]);
    expect(nonMemberHead).toMatchObject({ ok: false, error: { code: 'not_a_member' } });

    expect(() =>
      describeDepartmentChanges(snapshot, [
        { kind: 'head', departmentId: SALES_ID, userId: DIPAK_ID },
      ]),
    ).toThrow(DepartmentChangeValidationError);
  });
});
