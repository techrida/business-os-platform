'use server';

import {
  AccessWarningCodeSchema,
  DEPARTMENT_NAME_MAX,
  DEPARTMENT_NAME_MIN,
  DEPARTMENT_NOTE_MAX,
  DEPARTMENT_PEOPLE_MAX_CHANGES,
  DepartmentChangeSchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  mapAccessPreviewError,
  mapAccessSaveError,
  previewAccessChanges,
  saveAccessChanges,
} from '@/lib/api-access';
import {
  createDepartment,
  getDepartment,
  mapDepartmentWriteError,
  renameDepartment,
  restoreDepartment,
  retireDepartment,
} from '@/lib/api-departments';

import { requireSection } from '../guard';
import type {
  DepartmentRecordResult,
  PeoplePreviewResult,
  PeopleSaveResult,
  RetireMembersResult,
  RevisionResult,
} from './action-types';

// Server Actions for Settings > Departments. The browser never sees the access token: each action
// runs on the server with the session and calls the API itself. Each one re-checks the section,
// because an action is its own request. The API still decides who may write (`admin.roles.write`).

const PATH = '/settings/departments';

const Id = z.guid();
const Version = z.number().int().min(1);
const Name = z
  .string()
  .trim()
  .min(DEPARTMENT_NAME_MIN, `Enter a name of at least ${DEPARTMENT_NAME_MIN} characters.`)
  .max(DEPARTMENT_NAME_MAX, `Use at most ${DEPARTMENT_NAME_MAX} characters.`);
const MemberIds = z.array(z.guid()).max(10_000);
const Changes = z.array(DepartmentChangeSchema).min(1).max(DEPARTMENT_PEOPLE_MAX_CHANGES);
const UNREADABLE = 'These changes could not be read. Reload and try again.';

function invalid(message: string, field?: string): DepartmentRecordResult {
  return {
    ok: false,
    kind: 'invalid',
    message,
    ...(field !== undefined ? { fieldErrors: { [field]: message } } : {}),
  };
}

function revalidate(id?: string) {
  revalidatePath(PATH);
  if (id !== undefined) revalidatePath(`${PATH}/${id}`);
}

export async function createDepartmentAction(input: {
  name: string;
  headUserId: string | null;
}): Promise<DepartmentRecordResult> {
  const session = await requireSection('departments');
  const name = Name.safeParse(input.name);
  if (!name.success) return invalid(name.error.issues[0]?.message ?? 'Enter a name.', 'name');
  const head = input.headUserId === null ? null : Id.safeParse(input.headUserId);
  if (head !== null && !head.success) return invalid('Choose a head from the list.', 'headUserId');

  try {
    const created = await createDepartment(session, {
      name: name.data,
      ...(head !== null ? { headUserId: head.data } : {}),
    });
    revalidate();
    return { ok: true, id: created.id, name: created.name };
  } catch (error) {
    return { ok: false, ...mapDepartmentWriteError(error) };
  }
}

export async function renameDepartmentAction(
  id: string,
  name: string,
  expectedVersion: number,
): Promise<DepartmentRecordResult> {
  const session = await requireSection('departments');
  const parsedId = Id.safeParse(id);
  const version = Version.safeParse(expectedVersion);
  if (!parsedId.success || !version.success) return invalid('This department could not be found.');
  const parsedName = Name.safeParse(name);
  if (!parsedName.success) {
    return invalid(parsedName.error.issues[0]?.message ?? 'Enter a name.', 'name');
  }

  try {
    const renamed = await renameDepartment(session, parsedId.data, {
      name: parsedName.data,
      expectedVersion: version.data,
    });
    revalidate(renamed.id);
    return { ok: true, id: renamed.id, name: renamed.name };
  } catch (error) {
    return { ok: false, ...mapDepartmentWriteError(error) };
  }
}

const MEMBERS_UNREADABLE = 'The people in this department could not be loaded. Try again.';

/** The active members the retire dialog shows, loaded when it opens and after a refusal. */
export async function loadRetireMembersAction(id: string): Promise<RetireMembersResult> {
  const session = await requireSection('departments');
  const parsedId = Id.safeParse(id);
  if (!parsedId.success) return { ok: false, message: 'This department could not be found.' };
  try {
    const detail = await getDepartment(session, parsedId.data);
    if (detail === null) return { ok: false, message: 'This department could not be found.' };
    return { ok: true, memberIds: detail.members.map((member) => member.userId) };
  } catch {
    return { ok: false, message: MEMBERS_UNREADABLE };
  }
}

/**
 * `moveMembersTo`: an id moves the members there, `null` leaves them with no department, and
 * `undefined` is only for a department with no members. `expectedMemberIds` are the members the
 * dialog showed; when they no longer match, the result is `membersChanged` and nobody moves.
 */
export async function retireDepartmentAction(
  id: string,
  expectedVersion: number,
  moveMembersTo: string | null | undefined,
  expectedMemberIds?: readonly string[],
): Promise<DepartmentRecordResult> {
  const session = await requireSection('departments');
  const parsedId = Id.safeParse(id);
  const version = Version.safeParse(expectedVersion);
  if (!parsedId.success || !version.success) return invalid('This department could not be found.');
  if (typeof moveMembersTo === 'string' && !Id.safeParse(moveMembersTo).success) {
    return invalid('Choose where the people go.', 'moveMembersTo');
  }
  const members = expectedMemberIds === undefined ? null : MemberIds.safeParse(expectedMemberIds);
  if (members !== null && !members.success) return invalid(UNREADABLE);

  try {
    const retired = await retireDepartment(session, parsedId.data, {
      expectedVersion: version.data,
      ...(moveMembersTo !== undefined ? { moveMembersTo } : {}),
      ...(members !== null ? { expectedMemberIds: members.data } : {}),
    });
    revalidate(retired.id);
    if (typeof moveMembersTo === 'string') revalidate(moveMembersTo);
    return { ok: true, id: retired.id, name: retired.name };
  } catch (error) {
    return { ok: false, ...mapDepartmentWriteError(error) };
  }
}

export async function restoreDepartmentAction(
  id: string,
  expectedVersion: number,
): Promise<DepartmentRecordResult> {
  const session = await requireSection('departments');
  const parsedId = Id.safeParse(id);
  const version = Version.safeParse(expectedVersion);
  if (!parsedId.success || !version.success) return invalid('This department could not be found.');

  try {
    const restored = await restoreDepartment(session, parsedId.data, {
      expectedVersion: version.data,
    });
    revalidate(restored.id);
    return { ok: true, id: restored.id, name: restored.name };
  } catch (error) {
    return { ok: false, ...mapDepartmentWriteError(error) };
  }
}

/** The review dialog's dry run for staged people changes. Writes nothing. */
export async function previewDepartmentPeopleAction(
  changes: unknown,
): Promise<PeoplePreviewResult> {
  const session = await requireSection('departments');
  const parsed = Changes.safeParse(changes);
  if (!parsed.success) return { ok: false, message: UNREADABLE };

  try {
    return { ok: true, preview: await previewAccessChanges(session, { changes: parsed.data }) };
  } catch (error) {
    return { ok: false, message: mapAccessPreviewError(error) };
  }
}

/** Saves staged people changes for one department against the access revision (spec 5.2 path b). */
export async function saveDepartmentPeopleAction(
  departmentId: string,
  input: { changes: unknown; expectedRevision: string; acknowledged: string[]; note: string },
): Promise<PeopleSaveResult> {
  const session = await requireSection('departments');
  const id = Id.safeParse(departmentId);
  const changes = Changes.safeParse(input.changes);
  const rest = z
    .object({
      expectedRevision: z.string().min(1),
      note: z.string(),
      acknowledged: z.array(AccessWarningCodeSchema).max(20),
    })
    .safeParse(input);
  if (!id.success || !changes.success || !rest.success) {
    return { ok: false, kind: 'invalid', message: UNREADABLE };
  }
  const note = rest.data.note.trim().slice(0, DEPARTMENT_NOTE_MAX);

  // People changes go through the one access save, so the server re-checks every warning and
  // the review dialog's dry run and the save agree (spec 7.4: no other endpoint).
  try {
    await saveAccessChanges(session, {
      changes: changes.data,
      expectedRevision: rest.data.expectedRevision,
      acknowledged: rest.data.acknowledged,
      ...(note !== '' ? { note } : {}),
    });
  } catch (error) {
    return { ok: false, ...mapAccessSaveError(error) };
  }
  revalidate(id.data);
  for (const change of changes.data) {
    if (change.kind === 'memberMove') revalidate(change.toDepartmentId);
  }
  return { ok: true };
}

/** The current access revision, read from a department, for a save started outside its page. */
export async function departmentRevisionAction(departmentId: string): Promise<RevisionResult> {
  const session = await requireSection('departments');
  const id = Id.safeParse(departmentId);
  if (!id.success) return { ok: false, message: 'Choose a department.' };
  try {
    const detail = await getDepartment(session, id.data);
    if (detail === null) return { ok: false, message: 'This department could not be found.' };
    if (detail.status !== 'active') {
      return { ok: false, message: `${detail.name} is retired. Choose an active department.` };
    }
    return { ok: true, revision: detail.revision };
  } catch {
    return { ok: false, message: 'The department could not be loaded. Try again in a moment.' };
  }
}
