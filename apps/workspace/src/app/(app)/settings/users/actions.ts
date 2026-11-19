'use server';

import { RoleKeySchema, type RoleKey } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import { inviteUser, sendPasswordReset, setUserRoles } from '@/lib/api-admin';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { requireSection } from '../guard';

// Server Actions for the users page. The browser never sees the access token: the action runs on the
// server with the session and calls the API itself. Each action re-checks the session because it is
// its own HTTP request, separate from the page that rendered the form.

const PATH = '/settings/users';

const InviteSchema = z.object({
  email: z.email('Enter a valid email address.').max(320),
  givenName: z.string().trim().min(1, 'Enter a given name.').max(200),
  familyName: z.string().trim().min(1, 'Enter a family name.').max(200),
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

  try {
    await inviteUser(session, { ...parsed.data, roles });
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
