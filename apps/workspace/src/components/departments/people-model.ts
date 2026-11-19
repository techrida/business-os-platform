// The People card's staged state and the rules that turn it into API changes (spec 5.2, 5.3).
// No React and no server import: the card only wires events to these functions, and every rule is
// unit-tested here.
//
// One source of truth for the head: a person's level. The Head field shows whoever is staged as
// Head, and picking someone there is the same as setting their level to Head, so the two controls
// always agree (spec 5.3 "One head, or none").
import {
  DEPARTMENT_JOB_TITLE_MAX,
  DEPARTMENT_PEOPLE_MAX_CHANGES,
  type AccessLevel,
  type AdminDepartmentDetail,
  type DepartmentChange,
  type RoleKey,
} from '@bos/contracts';

export const LEVEL_LABEL: Record<AccessLevel, string> = {
  staff: 'Staff',
  manager: 'Manager',
  head: 'Head',
};

export const LEVEL_OPTIONS: readonly { value: AccessLevel; label: string }[] = [
  { value: 'staff', label: 'Staff' },
  { value: 'manager', label: 'Manager' },
  { value: 'head', label: 'Head' },
];

export interface DepartmentRef {
  id: string;
  name: string;
}

/** Someone who can be added: from the staff list, with the department they are in now. */
export interface PersonCandidate {
  id: string;
  name: string;
  email: string | null;
  roles: RoleKey[];
  department: DepartmentRef | null;
}

export type Leaving = null | { kind: 'remove' } | { kind: 'move'; to: DepartmentRef };

export interface StagedPerson {
  userId: string;
  name: string;
  email: string | null;
  roles: RoleKey[];
  since: string | null;
  /** '' means no job title. */
  jobTitle: string;
  level: AccessLevel;
  /** `member` was in the department when the page loaded; `added` joins with this save. */
  origin: 'member' | 'added';
  /** For an added person, the department they leave (null when they had none). */
  fromDepartment: DepartmentRef | null;
  /** A member staged to be removed or moved to another department. */
  leaving: Leaving;
}

export interface PeopleState {
  department: DepartmentRef;
  people: StagedPerson[];
}

export function initialPeopleState(detail: AdminDepartmentDetail): PeopleState {
  return {
    department: { id: detail.id, name: detail.name },
    people: detail.members.map((member): StagedPerson => ({
      userId: member.userId,
      name: member.name,
      email: member.email,
      roles: [...member.roles],
      since: member.since,
      jobTitle: member.jobTitle ?? '',
      level: member.level,
      origin: 'member',
      fromDepartment: null,
      leaving: null,
    })),
  };
}

const staying = (person: StagedPerson): boolean => person.leaving === null;

/** The staged head: the one staying person whose level is Head, or null for "No head". */
export function headOf(state: PeopleState): StagedPerson | null {
  return state.people.find((person) => staying(person) && person.level === 'head') ?? null;
}

function update(
  state: PeopleState,
  userId: string,
  change: (person: StagedPerson) => StagedPerson,
): PeopleState {
  return {
    ...state,
    people: state.people.map((person) => (person.userId === userId ? change(person) : person)),
  };
}

/**
 * Sets one person's level. Making someone Head makes the previous head a manager in the same step,
 * so there is never more than one head.
 */
export function setLevel(state: PeopleState, userId: string, level: AccessLevel): PeopleState {
  const target = state.people.find((person) => person.userId === userId);
  if (target === undefined || !staying(target)) return state;
  return {
    ...state,
    people: state.people.map((person): StagedPerson => {
      if (person.userId === userId) return { ...person, level };
      if (level === 'head' && staying(person) && person.level === 'head') {
        return { ...person, level: 'manager' };
      }
      return person;
    }),
  };
}

/** The Head field: a member's id makes them head; null leaves the department with no head. */
export function setHead(state: PeopleState, userId: string | null): PeopleState {
  if (userId !== null) return setLevel(state, userId, 'head');
  const head = headOf(state);
  return head === null ? state : setLevel(state, head.userId, 'manager');
}

export function setJobTitle(state: PeopleState, userId: string, jobTitle: string): PeopleState {
  return update(state, userId, (person) => ({
    ...person,
    jobTitle: jobTitle.slice(0, DEPARTMENT_JOB_TITLE_MAX),
  }));
}

/** Adds people as Staff. Someone already listed (even staged to leave) is not added twice. */
export function addPeople(state: PeopleState, candidates: readonly PersonCandidate[]): PeopleState {
  const listed = new Set(state.people.map((person) => person.userId));
  const added: StagedPerson[] = [];
  for (const candidate of candidates) {
    if (listed.has(candidate.id)) continue;
    listed.add(candidate.id);
    added.push({
      userId: candidate.id,
      name: candidate.name,
      email: candidate.email,
      roles: [...candidate.roles],
      since: null,
      jobTitle: '',
      level: 'staff',
      origin: 'added',
      fromDepartment:
        candidate.department !== null && candidate.department.id !== state.department.id
          ? { ...candidate.department }
          : null,
      leaving: null,
    });
  }
  return added.length === 0 ? state : { ...state, people: [...state.people, ...added] };
}

/** Removes people. A person added in this edit simply drops out; a member is staged to leave. */
export function removePeople(state: PeopleState, userIds: readonly string[]): PeopleState {
  const ids = new Set(userIds);
  return {
    ...state,
    people: state.people
      .filter((person) => !(ids.has(person.userId) && person.origin === 'added'))
      .map(
        (person): StagedPerson =>
          ids.has(person.userId) ? { ...person, leaving: { kind: 'remove' } } : person,
      ),
  };
}

/** Moves members to another department. A person added in this edit stays where they were. */
export function movePeople(
  state: PeopleState,
  userIds: readonly string[],
  to: DepartmentRef,
): PeopleState {
  if (to.id === state.department.id) return state;
  const ids = new Set(userIds);
  return {
    ...state,
    people: state.people
      .filter((person) => !(ids.has(person.userId) && person.origin === 'added'))
      .map(
        (person): StagedPerson =>
          ids.has(person.userId) ? { ...person, leaving: { kind: 'move', to: { ...to } } } : person,
      ),
  };
}

/**
 * Undoes a staged remove or move. A returning head who meanwhile has a successor comes back a
 * manager.
 */
export function keepPerson(state: PeopleState, userId: string): PeopleState {
  const head = headOf(state);
  return update(state, userId, (person) => ({
    ...person,
    leaving: null,
    level:
      person.level === 'head' && head !== null && head.userId !== userId ? 'manager' : person.level,
  }));
}

/**
 * Sets the level of several people at once. Head is a one-person choice, so it is not offered in
 * bulk.
 */
export function setLevelMany(
  state: PeopleState,
  userIds: readonly string[],
  level: Exclude<AccessLevel, 'head'>,
): PeopleState {
  return userIds.reduce((next, userId) => setLevel(next, userId, level), state);
}

const normalizeTitle = (title: string | null): string | null => {
  const trimmed = (title ?? '').trim();
  return trimmed === '' ? null : trimmed;
};

/**
 * The changes a save sends, in the order the server applies them: people leaving first (so a
 * leaving head never shows up as "becomes a manager"), then people joining (with their level and
 * job title), then the head, then levels, then job titles. A new head who was already a member is a
 * `head` change, never a `memberLevel` to Head: the server then demotes the previous head itself.
 */
export function buildDepartmentChanges(
  initial: PeopleState,
  staged: PeopleState,
): DepartmentChange[] {
  const departmentId = staged.department.id;
  const before = new Map(initial.people.map((person) => [person.userId, person]));
  const initialHead = initial.people.find((person) => person.level === 'head')?.userId ?? null;
  const stagedHead = headOf(staged);
  const changes: DepartmentChange[] = [];

  for (const person of staged.people) {
    if (person.origin !== 'member' || person.leaving === null) continue;
    changes.push(
      person.leaving.kind === 'remove'
        ? { kind: 'memberRemove', departmentId, userId: person.userId }
        : {
            kind: 'memberMove',
            userId: person.userId,
            fromDepartmentId: departmentId,
            toDepartmentId: person.leaving.to.id,
          },
    );
  }

  for (const person of staged.people) {
    if (person.origin !== 'added') continue;
    const jobTitle = normalizeTitle(person.jobTitle);
    changes.push({
      kind: 'memberAdd',
      departmentId,
      userId: person.userId,
      level: person.level,
      ...(jobTitle !== null ? { jobTitle } : {}),
    });
  }

  const initialHeadPerson =
    initialHead === null ? undefined : staged.people.find((p) => p.userId === initialHead);
  const initialHeadStays = initialHeadPerson !== undefined && staying(initialHeadPerson);
  const stagedHeadId = stagedHead?.userId ?? null;
  if (stagedHeadId !== initialHead) {
    if (stagedHead === null) {
      // A leaving head already leaves the department without one.
      if (initialHeadStays) changes.push({ kind: 'head', departmentId, userId: null });
    } else if (stagedHead.origin === 'member') {
      changes.push({ kind: 'head', departmentId, userId: stagedHead.userId });
    }
    // An added head joins with level Head through memberAdd.
  }

  // The level each staying member has once the head step above has run on the server.
  const levelAfterHeadStep = (person: StagedPerson): AccessLevel => {
    const original = before.get(person.userId)?.level ?? person.level;
    if (person.userId === stagedHeadId) return 'head';
    if (person.userId === initialHead && stagedHeadId !== initialHead) return 'manager';
    return original;
  };

  for (const person of staged.people) {
    if (person.origin !== 'member' || !staying(person) || person.level === 'head') continue;
    if (person.level !== levelAfterHeadStep(person)) {
      changes.push({
        kind: 'memberLevel',
        departmentId,
        userId: person.userId,
        level: person.level,
      });
    }
  }

  for (const person of staged.people) {
    if (person.origin !== 'member' || !staying(person)) continue;
    const next = normalizeTitle(person.jobTitle);
    if (next !== normalizeTitle(before.get(person.userId)?.jobTitle ?? null)) {
      changes.push({ kind: 'memberJobTitle', departmentId, userId: person.userId, jobTitle: next });
    }
  }

  return changes;
}

/** True when the API would refuse the batch for its size. */
export function tooManyChanges(changes: readonly DepartmentChange[]): boolean {
  return changes.length > DEPARTMENT_PEOPLE_MAX_CHANGES;
}

/**
 * Plain notices for moves the review dialog cannot word from the dry run (spec 5.3, 8.2): records a
 * person owns stay under the department they were created in.
 */
export function recordNotices(state: PeopleState): string[] {
  const here = state.department.name;
  const notices: string[] = [];
  for (const person of state.people) {
    if (person.origin === 'added' && person.fromDepartment !== null) {
      notices.push(
        `Records ${person.name} owns stay with ${person.fromDepartment.name}. ` +
          `Reassign them if ${here} should have them.`,
      );
    } else if (person.leaving?.kind === 'move') {
      notices.push(
        `Records ${person.name} owns stay with ${here}. ` +
          `Reassign them if ${person.leaving.to.name} should have them.`,
      );
    } else if (person.leaving?.kind === 'remove') {
      notices.push(`Records ${person.name} owns stay with them and stay under ${here}.`);
    }
  }
  return notices;
}

/** The members table's own search and Level filter, applied to the staged list. */
export function filterPeople(
  people: readonly StagedPerson[],
  query: string,
  levels: readonly AccessLevel[],
): StagedPerson[] {
  const needle = query.trim().toLocaleLowerCase();
  const wanted = new Set(levels);
  return people.filter((person) => {
    if (wanted.size > 0 && !wanted.has(person.level)) return false;
    if (needle === '') return true;
    return [person.name, person.email ?? '', person.jobTitle].some((text) =>
      text.toLocaleLowerCase().includes(needle),
    );
  });
}
