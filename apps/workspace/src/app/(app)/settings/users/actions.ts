'use server';

import { AccessLevelSchema, RoleKeySchema, type RoleKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  changeUserStatus,
  inviteUser,
  resolveUserIdentity,
  sendPasswordReset,
  setUserRoles,
  type UserStatusAction,
} from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Server Actions for the users page. The browser never sees the access token: the action runs on the
// server with the session and calls the API itself. Each action re-checks the session because it is
// its own HTTP request, separate from the page that rendered the form.

const PATH = '/settings/users';

const InviteSchema = z
  .object({
    email: z.email('Enter a valid email address.').max(320),
    givenName: z.string().trim().min(1, 'Enter a given name.').max(200),
    familyName: z.string().trim().min(1, 'Enter a family name.').max(200),
    // F1-Q50: both optional. An empty department is "no department"; an empty level is staff.
    departmentId: z.union([z.literal(''), z.guid('Choose a department from the list.')]),
    level: z.union([z.literal(''), AccessLevelSchema]),
  })
  .refine((v) => v.level !== 'head' || v.departmentId !== '', {
    path: ['departmentId'],
    message: 'Choose a department for a department head.',
  });

function rolesFrom(formData: FormData): RoleKey[] {
  const roles: RoleKey[] = [];
  for (const value of formData.getAll('roles')) {
    const parsed = RoleKeySchema.safeParse(value);
    if (parsed.success && !roles.includes(parsed.data)) roles.push(parsed.data);
  }
  return roles;
}

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

export async function inviteUserAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('users');
  const roles = rolesFrom(formData);
  const fields = {
    email: text(formData, 'email').trim(),
    givenName: text(formData, 'givenName'),
    familyName: text(formData, 'familyName'),
    departmentId: text(formData, 'departmentId'),
    level: text(formData, 'level'),
    roles: roles.join(','),
  };

  const parsed = InviteSchema.safeParse(fields);
  if (!parsed.success) {
    return {
      ...fail('Check the highlighted fields.', fields),
      fieldErrors: Object.fromEntries(
        parsed.error.issues.map((issue) => [String(issue.path[0]), issue.message]),
      ),
    };
  }

  const { departmentId, level, ...person } = parsed.data;
  try {
    await inviteUser(session, {
      ...person,
      roles,
      ...(departmentId !== '' ? { departmentId } : {}),
      ...(level !== '' ? { level } : {}),
    });
  } catch (error) {
    return fail(describeError(error, 'invite users'), fields);
  }
  revalidatePath(PATH);
  return ok(`Invitation sent to ${parsed.data.email}.`);
}

export async function setRolesAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('users');
  const userId = text(formData, 'userId');
  const roles = rolesFrom(formData);
  if (userId === '') return fail('Missing user.');

  try {
    await setUserRoles(session, userId, roles);
  } catch (error) {
    return fail(describeError(error, 'change user roles'));
  }
  revalidatePath(PATH);
  return ok(roles.length === 0 ? 'All roles removed.' : 'Roles saved.');
}

export async function sendPasswordResetAction(userId: string): Promise<ActionState> {
  const session = await requireSection('users');
  const parsed = z.uuid().safeParse(userId);
  if (!parsed.success) return fail('Missing user.');

  try {
    await sendPasswordReset(session, parsed.data);
    return ok('Password reset email sent.');
  } catch (error) {
    return fail(describeError(error, 'send password reset emails'));
  }
}

const STATUS_DONE: Record<UserStatusAction, { done: string; action: string }> = {
  deactivate: { done: 'User deactivated.', action: 'deactivate users' },
  reactivate: { done: 'User reactivated.', action: 'reactivate users' },
  lock: { done: 'User locked.', action: 'lock users' },
  unlock: { done: 'User unlocked.', action: 'unlock users' },
};

export async function changeUserStatusAction(
  userId: string,
  action: UserStatusAction,
): Promise<ActionState> {
  const session = await requireSection('users');
  const parsed = z.uuid().safeParse(userId);
  if (!parsed.success || !Object.hasOwn(STATUS_DONE, action)) return fail('Missing user.');

  try {
    await changeUserStatus(session, parsed.data, action);
  } catch (error) {
    return fail(describeError(error, STATUS_DONE[action].action));
  }
  revalidatePath(PATH);
  return ok(STATUS_DONE[action].done);
}

/** Clears a flag after the API reads the identity provider again; a 503 or 409 comes back as the message. */
export async function resolveIdentityAction(userId: string): Promise<ActionState> {
  const session = await requireSection('users');
  const parsed = z.uuid().safeParse(userId);
  if (!parsed.success) return fail('Missing user.');

  try {
    await resolveUserIdentity(session, parsed.data);
  } catch (error) {
    // 503: ZITADEL could not be read (or is not configured). Nothing changed and the flag stays, whatever message came.
    if (typeof error === 'object' && error !== null && 'status' in error && error.status === 503) {
      return fail(
        'The identity provider could not be read, so nothing changed and the flag stays. Try again later.',
      );
    }
    return fail(describeError(error, 'resolve flagged users'));
  }
  revalidatePath(PATH);
  revalidatePath(`${PATH}/flagged`);
  return ok('Flag resolved.');
}
