// Pure state-transition and description helpers for department membership and leadership edits.
// Shared between the departments admin service (POST /v1/admin/departments/:id/people) and the
// Access review dry-run (B2), so both paths validate the exact same invariants and surface the
// same automatic side-effects (such as demoting a previous head to manager).
import type {
  AccessLevel,
  DepartmentChange,
  DepartmentChangeEffect,
  DepartmentStatus,
} from '@bos/contracts';

export interface DepartmentSnapshotRow {
  readonly id: string;
  readonly name: string;
  readonly status: DepartmentStatus;
  readonly headUserId: string | null;
}

export interface DepartmentPersonSnapshot {
  readonly userId: string;
  readonly name: string;
  /** True only for active staff users with a membership in this legal entity. */
  readonly active: boolean;
  readonly departmentId: string | null;
  readonly level: AccessLevel;
  readonly jobTitle: string | null;
}

export interface DepartmentSnapshot {
  readonly departments: readonly DepartmentSnapshotRow[];
  readonly people: readonly DepartmentPersonSnapshot[];
}

export type DepartmentChangeFailureCode =
  | 'department_not_found'
  | 'department_retired'
  | 'person_not_found'
  | 'person_inactive'
  | 'not_a_member'
  | 'already_a_member'
  | 'same_department_move'
  | 'source_department_mismatch';

export interface DepartmentChangeFailure {
  readonly index: number;
  readonly code: DepartmentChangeFailureCode;
  readonly message: string;
  readonly field: string;
}

export type DepartmentAuditAction =
  | 'department.member.added'
  | 'department.member.moved'
  | 'department.member.removed'
  | 'department.member.level_changed'
  | 'department.member.job_title_changed'
  | 'department.head.changed';

export interface DepartmentAuditEntryPlan {
  readonly action: DepartmentAuditAction;
  readonly departmentId: string;
  readonly userId: string | null;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
  readonly summary: string;
}

export type ApplyDepartmentChangesResult =
  | {
      readonly ok: true;
      readonly next: DepartmentSnapshot;
      readonly effects: readonly DepartmentChangeEffect[];
      readonly auditEntries: readonly DepartmentAuditEntryPlan[];
      readonly changedUserIds: readonly string[];
      readonly changedDepartmentIds: readonly string[];
    }
  | {
      readonly ok: false;
      readonly error: DepartmentChangeFailure;
    };

export class DepartmentChangeValidationError extends Error {
  readonly failure: DepartmentChangeFailure;

  constructor(failure: DepartmentChangeFailure) {
    super(failure.message);
    this.name = 'DepartmentChangeValidationError';
    this.failure = failure;
  }
}

interface MutableDepartment {
  id: string;
  name: string;
  status: DepartmentStatus;
  headUserId: string | null;
}

interface MutablePerson {
  userId: string;
  name: string;
  active: boolean;
  departmentId: string | null;
  level: AccessLevel;
  jobTitle: string | null;
}

function fail(
  index: number,
  code: DepartmentChangeFailureCode,
  field: string,
  message: string,
): ApplyDepartmentChangesResult {
  return { ok: false, error: { index, code, field, message } };
}

function normalizeJobTitle(jobTitle: string | null): string | null {
  if (jobTitle === null) return null;
  const trimmed = jobTitle.trim();
  return trimmed.length === 0 ? null : trimmed;
}

function levelPhrase(level: AccessLevel): string {
  switch (level) {
    case 'head':
      return 'head';
    case 'manager':
      return 'a manager';
    case 'staff':
      return 'staff';
  }
}

/**
 * Applies a sequence of `DepartmentChange` items to an immutable snapshot without mutating it.
 * Mirrors the invariants enforced by migration 0079 (`user_entities_sync_department_head` and
 * `departments_sync_head_level`) so callers know the exact final state, automatic side-effects,
 * and audit entries before touching the database.
 */
export function applyDepartmentChanges(
  snapshot: DepartmentSnapshot,
  changes: readonly DepartmentChange[],
): ApplyDepartmentChangesResult {
  const departments = new Map<string, MutableDepartment>();
  for (const row of snapshot.departments) {
    departments.set(row.id, { ...row });
  }
  const people = new Map<string, MutablePerson>();
  for (const person of snapshot.people) {
    people.set(person.userId, { ...person });
  }

  const effects: DepartmentChangeEffect[] = [];
  const auditEntries: DepartmentAuditEntryPlan[] = [];
  const changedUserIds = new Set<string>();
  const changedDepartmentIds = new Set<string>();

  const demoteExistingHead = (dept: MutableDepartment, excludingUserId: string | null): void => {
    const prevHeadId = dept.headUserId;
    if (prevHeadId === null || prevHeadId === excludingUserId) return;
    const prevHead = people.get(prevHeadId);
    if (prevHead === undefined || prevHead.departmentId !== dept.id || prevHead.level !== 'head') {
      return;
    }
    prevHead.level = 'manager';
    changedUserIds.add(prevHead.userId);
    const summary = `${prevHead.name} becomes a manager in ${dept.name}`;
    effects.push({
      kind: 'headDemoted',
      summary,
      alsoChanges: true,
      departmentId: dept.id,
      userId: prevHead.userId,
    });
    auditEntries.push({
      action: 'department.member.level_changed',
      departmentId: dept.id,
      userId: prevHead.userId,
      before: { departmentId: dept.id, level: 'head' },
      after: { departmentId: dept.id, level: 'manager' },
      summary,
    });
  };

  for (let i = 0; i < changes.length; i++) {
    const change = changes[i];
    if (change === undefined) continue;

    switch (change.kind) {
      case 'memberAdd': {
        const dept = departments.get(change.departmentId);
        if (dept === undefined) {
          return fail(i, 'department_not_found', 'departmentId', 'Department not found.');
        }
        if (dept.status !== 'active') {
          return fail(
            i,
            'department_retired',
            'departmentId',
            `Cannot add people to retired department ${dept.name}.`,
          );
        }
        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (!person.active) {
          return fail(
            i,
            'person_inactive',
            'userId',
            `${person.name} is not active and cannot be assigned to a department.`,
          );
        }
        if (person.departmentId === dept.id) {
          return fail(
            i,
            'already_a_member',
            'userId',
            `${person.name} is already a member of ${dept.name}.`,
          );
        }

        const prevDeptId = person.departmentId;
        const prevDept = prevDeptId !== null ? departments.get(prevDeptId) : undefined;
        const prevLevel = person.level;
        const prevJobTitle = person.jobTitle;
        const wasHeadOfPrev =
          prevDept !== undefined && (prevDept.headUserId === person.userId || prevLevel === 'head');

        const nextLevel: AccessLevel =
          change.level !== undefined
            ? change.level
            : prevDeptId !== null
              ? prevLevel === 'head'
                ? 'manager'
                : prevLevel
              : 'staff';
        const nextJobTitle =
          change.jobTitle !== undefined ? normalizeJobTitle(change.jobTitle) : prevJobTitle;

        const prevTargetHeadId = dept.headUserId;

        person.departmentId = dept.id;
        person.level = nextLevel;
        person.jobTitle = nextJobTitle;
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(dept.id);

        if (prevDept !== undefined) {
          const summary = `${person.name} moves from ${prevDept.name} to ${dept.name}`;
          effects.push({
            kind: 'memberMove',
            summary,
            alsoChanges: false,
            departmentId: dept.id,
            fromDepartmentId: prevDept.id,
            userId: person.userId,
          });
          auditEntries.push({
            action: 'department.member.moved',
            departmentId: dept.id,
            userId: person.userId,
            before: { departmentId: prevDept.id, level: prevLevel, jobTitle: prevJobTitle },
            after: { departmentId: dept.id, level: nextLevel, jobTitle: nextJobTitle },
            summary,
          });
          if (wasHeadOfPrev) {
            prevDept.headUserId = null;
            changedDepartmentIds.add(prevDept.id);
            const clearSummary = `${prevDept.name} will have no head`;
            effects.push({
              kind: 'head',
              summary: clearSummary,
              alsoChanges: true,
              departmentId: prevDept.id,
              userId: null,
            });
            auditEntries.push({
              action: 'department.head.changed',
              departmentId: prevDept.id,
              userId: null,
              before: { headUserId: person.userId },
              after: { headUserId: null },
              summary: clearSummary,
            });
            if (nextLevel !== 'head') {
              effects.push({
                kind: 'headDemoted',
                summary: `${person.name} becomes ${levelPhrase(nextLevel)} in ${dept.name}`,
                alsoChanges: true,
                departmentId: dept.id,
                userId: person.userId,
              });
            }
          }
        } else {
          const summary = `${person.name} joins ${dept.name}`;
          effects.push({
            kind: 'memberAdd',
            summary,
            alsoChanges: false,
            departmentId: dept.id,
            userId: person.userId,
          });
          auditEntries.push({
            action: 'department.member.added',
            departmentId: dept.id,
            userId: person.userId,
            before: { departmentId: null, level: prevLevel, jobTitle: prevJobTitle },
            after: { departmentId: dept.id, level: nextLevel, jobTitle: nextJobTitle },
            summary,
          });
        }

        if (nextLevel === 'head') {
          demoteExistingHead(dept, person.userId);
          dept.headUserId = person.userId;
          if (prevTargetHeadId !== person.userId) {
            auditEntries.push({
              action: 'department.head.changed',
              departmentId: dept.id,
              userId: person.userId,
              before: { headUserId: prevTargetHeadId },
              after: { headUserId: person.userId },
              summary: `${person.name} becomes head of ${dept.name}`,
            });
          }
        }
        break;
      }

      case 'memberMove': {
        if (change.fromDepartmentId === change.toDepartmentId) {
          return fail(
            i,
            'same_department_move',
            'toDepartmentId',
            'Destination department must be different from the current department.',
          );
        }
        const fromDept = departments.get(change.fromDepartmentId);
        if (fromDept === undefined) {
          return fail(
            i,
            'department_not_found',
            'fromDepartmentId',
            'Source department not found.',
          );
        }
        const toDept = departments.get(change.toDepartmentId);
        if (toDept === undefined) {
          return fail(
            i,
            'department_not_found',
            'toDepartmentId',
            'Destination department not found.',
          );
        }
        if (toDept.status !== 'active') {
          return fail(
            i,
            'department_retired',
            'toDepartmentId',
            `Cannot move people into retired department ${toDept.name}.`,
          );
        }
        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (!person.active) {
          return fail(
            i,
            'person_inactive',
            'userId',
            `${person.name} is not active and cannot be moved between departments.`,
          );
        }
        if (person.departmentId !== fromDept.id) {
          return fail(
            i,
            'source_department_mismatch',
            'fromDepartmentId',
            `${person.name} is not a member of ${fromDept.name}.`,
          );
        }

        const prevLevel = person.level;
        const wasHead = fromDept.headUserId === person.userId || prevLevel === 'head';
        const nextLevel: AccessLevel = prevLevel === 'head' ? 'manager' : prevLevel;

        person.departmentId = toDept.id;
        person.level = nextLevel;
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(fromDept.id);
        changedDepartmentIds.add(toDept.id);

        const summary = `${person.name} moves from ${fromDept.name} to ${toDept.name}`;
        effects.push({
          kind: 'memberMove',
          summary,
          alsoChanges: false,
          departmentId: toDept.id,
          fromDepartmentId: fromDept.id,
          userId: person.userId,
        });
        auditEntries.push({
          action: 'department.member.moved',
          departmentId: toDept.id,
          userId: person.userId,
          before: { departmentId: fromDept.id, level: prevLevel },
          after: { departmentId: toDept.id, level: nextLevel },
          summary,
        });

        if (wasHead) {
          fromDept.headUserId = null;
          const clearSummary = `${fromDept.name} will have no head`;
          effects.push({
            kind: 'head',
            summary: clearSummary,
            alsoChanges: true,
            departmentId: fromDept.id,
            userId: null,
          });
          effects.push({
            kind: 'headDemoted',
            summary: `${person.name} becomes a manager in ${toDept.name}`,
            alsoChanges: true,
            departmentId: toDept.id,
            userId: person.userId,
          });
          auditEntries.push({
            action: 'department.head.changed',
            departmentId: fromDept.id,
            userId: null,
            before: { headUserId: person.userId },
            after: { headUserId: null },
            summary: clearSummary,
          });
        }
        break;
      }

      case 'memberRemove': {
        const dept = departments.get(change.departmentId);
        if (dept === undefined) {
          return fail(i, 'department_not_found', 'departmentId', 'Department not found.');
        }
        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (person.departmentId !== dept.id) {
          return fail(
            i,
            'not_a_member',
            'userId',
            `${person.name} is not a member of ${dept.name}.`,
          );
        }

        const prevLevel = person.level;
        const wasHead = dept.headUserId === person.userId || prevLevel === 'head';

        person.departmentId = null;
        person.level = 'staff';
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(dept.id);

        const summary = `${person.name} leaves ${dept.name}`;
        effects.push({
          kind: 'memberRemove',
          summary,
          alsoChanges: false,
          departmentId: dept.id,
          userId: person.userId,
        });
        auditEntries.push({
          action: 'department.member.removed',
          departmentId: dept.id,
          userId: person.userId,
          before: { departmentId: dept.id, level: prevLevel },
          after: { departmentId: null, level: 'staff' },
          summary,
        });

        if (wasHead) {
          dept.headUserId = null;
          const clearSummary = `${dept.name} will have no head`;
          effects.push({
            kind: 'head',
            summary: clearSummary,
            alsoChanges: true,
            departmentId: dept.id,
            userId: null,
          });
          auditEntries.push({
            action: 'department.head.changed',
            departmentId: dept.id,
            userId: null,
            before: { headUserId: person.userId },
            after: { headUserId: null },
            summary: clearSummary,
          });
        }
        break;
      }

      case 'memberLevel': {
        const dept = departments.get(change.departmentId);
        if (dept === undefined) {
          return fail(i, 'department_not_found', 'departmentId', 'Department not found.');
        }
        if (dept.status !== 'active') {
          return fail(
            i,
            'department_retired',
            'departmentId',
            `Cannot change levels in retired department ${dept.name}.`,
          );
        }
        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (!person.active) {
          return fail(
            i,
            'person_inactive',
            'userId',
            `${person.name} is not active and cannot have their level changed.`,
          );
        }
        if (person.departmentId !== dept.id) {
          return fail(
            i,
            'not_a_member',
            'userId',
            `${person.name} is not a member of ${dept.name}.`,
          );
        }

        if (person.level === change.level) break;

        const prevLevel = person.level;
        const prevHeadId = dept.headUserId;
        person.level = change.level;
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(dept.id);

        if (change.level === 'head') {
          const summary = `${person.name} becomes head of ${dept.name}`;
          effects.push({
            kind: 'memberLevel',
            summary,
            alsoChanges: false,
            departmentId: dept.id,
            userId: person.userId,
          });
          auditEntries.push({
            action: 'department.member.level_changed',
            departmentId: dept.id,
            userId: person.userId,
            before: { departmentId: dept.id, level: prevLevel },
            after: { departmentId: dept.id, level: 'head' },
            summary,
          });
          demoteExistingHead(dept, person.userId);
          dept.headUserId = person.userId;
          if (prevHeadId !== person.userId) {
            auditEntries.push({
              action: 'department.head.changed',
              departmentId: dept.id,
              userId: person.userId,
              before: { headUserId: prevHeadId },
              after: { headUserId: person.userId },
              summary,
            });
          }
        } else {
          const summary = `${person.name} becomes ${levelPhrase(change.level)} in ${dept.name}`;
          effects.push({
            kind: 'memberLevel',
            summary,
            alsoChanges: false,
            departmentId: dept.id,
            userId: person.userId,
          });
          auditEntries.push({
            action: 'department.member.level_changed',
            departmentId: dept.id,
            userId: person.userId,
            before: { departmentId: dept.id, level: prevLevel },
            after: { departmentId: dept.id, level: change.level },
            summary,
          });
          if (prevLevel === 'head' || dept.headUserId === person.userId) {
            dept.headUserId = null;
            const clearSummary = `${dept.name} will have no head`;
            effects.push({
              kind: 'head',
              summary: clearSummary,
              alsoChanges: true,
              departmentId: dept.id,
              userId: null,
            });
            auditEntries.push({
              action: 'department.head.changed',
              departmentId: dept.id,
              userId: null,
              before: { headUserId: person.userId },
              after: { headUserId: null },
              summary: clearSummary,
            });
          }
        }
        break;
      }

      case 'memberJobTitle': {
        const dept = departments.get(change.departmentId);
        if (dept === undefined) {
          return fail(i, 'department_not_found', 'departmentId', 'Department not found.');
        }
        if (dept.status !== 'active') {
          return fail(
            i,
            'department_retired',
            'departmentId',
            `Cannot edit job titles in retired department ${dept.name}.`,
          );
        }
        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (!person.active) {
          return fail(
            i,
            'person_inactive',
            'userId',
            `${person.name} is not active and cannot have their job title changed.`,
          );
        }
        if (person.departmentId !== dept.id) {
          return fail(
            i,
            'not_a_member',
            'userId',
            `${person.name} is not a member of ${dept.name}.`,
          );
        }

        const nextTitle = normalizeJobTitle(change.jobTitle);
        if (person.jobTitle === nextTitle) break;

        const prevTitle = person.jobTitle;
        person.jobTitle = nextTitle;
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(dept.id);

        const summary =
          nextTitle === null
            ? `Clear ${person.name}'s job title in ${dept.name}`
            : `${person.name}'s job title becomes ${nextTitle}`;
        effects.push({
          kind: 'memberJobTitle',
          summary,
          alsoChanges: false,
          departmentId: dept.id,
          userId: person.userId,
        });
        auditEntries.push({
          action: 'department.member.job_title_changed',
          departmentId: dept.id,
          userId: person.userId,
          before: { departmentId: dept.id, jobTitle: prevTitle },
          after: { departmentId: dept.id, jobTitle: nextTitle },
          summary,
        });
        break;
      }

      case 'head': {
        const dept = departments.get(change.departmentId);
        if (dept === undefined) {
          return fail(i, 'department_not_found', 'departmentId', 'Department not found.');
        }
        if (dept.status !== 'active') {
          return fail(
            i,
            'department_retired',
            'departmentId',
            `Cannot change the head of retired department ${dept.name}.`,
          );
        }

        if (change.userId === null) {
          if (dept.headUserId === null) break;
          const prevHeadId = dept.headUserId;
          const summary = `Clear head of ${dept.name}`;
          effects.push({
            kind: 'head',
            summary,
            alsoChanges: false,
            departmentId: dept.id,
            userId: null,
          });
          auditEntries.push({
            action: 'department.head.changed',
            departmentId: dept.id,
            userId: null,
            before: { headUserId: prevHeadId },
            after: { headUserId: null },
            summary,
          });
          demoteExistingHead(dept, null);
          dept.headUserId = null;
          changedDepartmentIds.add(dept.id);
          break;
        }

        const person = people.get(change.userId);
        if (person === undefined) {
          return fail(
            i,
            'person_not_found',
            'userId',
            'User is not a staff member of this legal entity.',
          );
        }
        if (!person.active) {
          return fail(
            i,
            'person_inactive',
            'userId',
            `${person.name} is not active and cannot lead ${dept.name}.`,
          );
        }
        if (person.departmentId !== dept.id) {
          return fail(
            i,
            'not_a_member',
            'userId',
            `${person.name} must belong to ${dept.name} to lead it.`,
          );
        }

        if (dept.headUserId === person.userId && person.level === 'head') break;

        const prevHeadId = dept.headUserId;
        const summary = `${person.name} becomes head of ${dept.name}`;
        effects.push({
          kind: 'head',
          summary,
          alsoChanges: false,
          departmentId: dept.id,
          userId: person.userId,
        });
        auditEntries.push({
          action: 'department.head.changed',
          departmentId: dept.id,
          userId: person.userId,
          before: { headUserId: prevHeadId },
          after: { headUserId: person.userId },
          summary,
        });

        demoteExistingHead(dept, person.userId);
        person.level = 'head';
        dept.headUserId = person.userId;
        changedUserIds.add(person.userId);
        changedDepartmentIds.add(dept.id);
        break;
      }
    }
  }

  return {
    ok: true,
    next: {
      departments: [...departments.values()].map((d) => ({ ...d })),
      people: [...people.values()].map((p) => ({ ...p })),
    },
    effects,
    auditEntries,
    changedUserIds: [...changedUserIds],
    changedDepartmentIds: [...changedDepartmentIds],
  };
}

/**
 * Produces the ordered list of human-readable effects (including automatic `alsoChanges` lines
 * such as previous head demotions) for a set of department changes. Throws
 * `DepartmentChangeValidationError` if any change is invalid against `snapshot`.
 */
export function describeDepartmentChanges(
  snapshot: DepartmentSnapshot,
  changes: readonly DepartmentChange[],
): readonly DepartmentChangeEffect[] {
  const result = applyDepartmentChanges(snapshot, changes);
  if (!result.ok) {
    throw new DepartmentChangeValidationError(result.error);
  }
  return result.effects;
}
