'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';

import {
  addApprovalGroupMember,
  addWorkflowVersion,
  createApprovalGroup,
  createDelegation,
  createWorkflow,
  deleteApprovalGroup,
  publishWorkflowVersion,
  removeApprovalGroupMember,
  revokeDelegation,
} from '@/lib/api-admin';
import { apiReasonOf } from '@/lib/api-code';

import { describeError } from '../admin-errors';
import { fail, ok, type ActionState } from '../action-state';
import { kathmanduLocalToIso } from '../format';
import { requireSection } from '../guard';
import { parseSpecJson } from './spec-form';

// Server Actions for the workflows page: definitions and versions, approval groups, delegations.
// Each one re-checks the session (it is its own request) and maps API errors to plain sentences.
// Writes use the `approvals.*` permissions, so a 403 here names the thing the user tried to do.

const PATH = '/settings/workflows';
const KEY = z
  .string()
  .regex(
    /^[a-z][a-z0-9_.-]{0,63}$/,
    'Use lowercase letters, digits, _ . - (start with a letter, max 64).',
  );
const NAME = z.string().trim().min(1, 'Enter a name.').max(200);

const text = (formData: FormData, name: string): string => {
  const value = formData.get(name);
  return typeof value === 'string' ? value : '';
};

function invalid(issues: readonly string[]): string {
  return `The workflow is not valid:\n${issues.map((i) => `- ${i}`).join('\n')}`;
}

// ---- workflows -------------------------------------------------------------------------------------

export async function createWorkflowAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const head = z.object({ key: KEY, name: NAME }).safeParse({
    key: text(formData, 'key').trim(),
    name: text(formData, 'name'),
  });
  if (!head.success) return fail(head.error.issues[0]?.message ?? 'Check the key and name.');
  const spec = parseSpecJson(text(formData, 'spec'));
  if (!spec.ok) return fail(invalid(spec.issues));

  try {
    await createWorkflow(session, { ...head.data, spec: spec.spec });
  } catch (error) {
    return fail(describeError(error, 'create workflows'));
  }
  revalidatePath(PATH);
  return ok(`Created "${head.data.name}" as draft version 1. Publish it from the list below.`);
}

/** There is no in-place edit: saving always adds the next version number as a new draft. */
export async function saveDraftAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const key = KEY.safeParse(text(formData, 'key'));
  if (!key.success) return fail('Missing workflow key.');
  const spec = parseSpecJson(text(formData, 'spec'));
  if (!spec.ok) return fail(invalid(spec.issues));

  try {
    const saved = await addWorkflowVersion(session, key.data, spec.spec);
    revalidatePath(PATH);
    return ok(`Saved as draft version ${saved.version}. It is not in use until you publish it.`);
  } catch (error) {
    return fail(describeError(error, 'edit workflows'));
  }
}

export async function publishVersionAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const key = KEY.safeParse(text(formData, 'key'));
  const version = z.coerce.number().int().positive().safeParse(text(formData, 'version'));
  if (!key.success || !version.success) return fail('Missing workflow version.');
  // The small-team rule (F1-Q11 a): the only person who may publish gives a reason, which the API audits.
  const reason = text(formData, 'reason').trim();
  if (reason.length > 500) return fail('Keep the reason to 500 characters or fewer.');

  try {
    await publishWorkflowVersion(
      session,
      key.data,
      version.data,
      reason === '' ? undefined : reason,
    );
  } catch (error) {
    if (apiReasonOf(error) === 'sole_eligible_reason_required') {
      return fail(
        'You are the only person who can publish this, so give a reason for publishing your own draft.',
      );
    }
    return fail(describeError(error, 'publish workflows'));
  }
  revalidatePath(PATH);
  return ok(`Version ${version.data} is published.`);
}

// ---- approval groups -------------------------------------------------------------------------------

export async function createGroupAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const fields = { key: text(formData, 'key').trim(), name: text(formData, 'name') };
  const parsed = z.object({ key: KEY, name: NAME }).safeParse(fields);
  if (!parsed.success) return fail(parsed.error.issues[0]?.message ?? 'Check the form.', fields);

  try {
    await createApprovalGroup(session, parsed.data);
  } catch (error) {
    return fail(describeError(error, 'manage approval groups'), fields);
  }
  revalidatePath(PATH);
  return ok(`Created group "${parsed.data.name}".`);
}

export async function deleteGroupAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const id = text(formData, 'id');
  if (id === '') return fail('Missing group.');
  try {
    await deleteApprovalGroup(session, id);
  } catch (error) {
    return fail(describeError(error, 'manage approval groups'));
  }
  revalidatePath(PATH);
  return ok('Group deleted.');
}

export async function addMemberAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const groupId = text(formData, 'groupId');
  const userId = text(formData, 'userId').trim();
  if (groupId === '' || userId === '') return fail('Choose a person to add.');
  try {
    await addApprovalGroupMember(session, groupId, userId);
  } catch (error) {
    return fail(describeError(error, 'manage approval groups'));
  }
  revalidatePath(PATH);
  return ok('Member added.');
}

export async function removeMemberAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const groupId = text(formData, 'groupId');
  const userId = text(formData, 'userId');
  if (groupId === '' || userId === '') return fail('Missing member.');
  try {
    await removeApprovalGroupMember(session, groupId, userId);
  } catch (error) {
    return fail(describeError(error, 'manage approval groups'));
  }
  revalidatePath(PATH);
  return ok('Member removed.');
}

// ---- delegations -----------------------------------------------------------------------------------

export async function createDelegationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const fields = {
    fromUserId: text(formData, 'fromUserId').trim(),
    toUserId: text(formData, 'toUserId').trim(),
    startsAt: text(formData, 'startsAt'),
    endsAt: text(formData, 'endsAt'),
    documentType: text(formData, 'documentType').trim(),
  };
  if (fields.fromUserId === '' || fields.toUserId === '') {
    return fail('Choose who is handing over and who takes over.', fields);
  }
  if (fields.fromUserId === fields.toUserId) {
    return fail('A person cannot delegate to themselves.', fields);
  }
  // The form has no zone; the API needs an offset. Admins type Nepal time.
  const startsAt = kathmanduLocalToIso(fields.startsAt);
  const endsAt = kathmanduLocalToIso(fields.endsAt);
  if (!startsAt || !endsAt) return fail('Enter both a start and an end time.', fields);
  if (new Date(endsAt) <= new Date(startsAt)) {
    return fail('The end must be after the start.', fields);
  }

  try {
    await createDelegation(session, {
      fromUserId: fields.fromUserId,
      toUserId: fields.toUserId,
      startsAt,
      endsAt,
      documentType: fields.documentType === '' ? null : fields.documentType,
    });
  } catch (error) {
    return fail(describeError(error, 'manage delegations'), fields);
  }
  revalidatePath(PATH);
  return ok('Delegation created.');
}

export async function revokeDelegationAction(
  _previous: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const session = await requireSection('workflows');
  const id = text(formData, 'id');
  if (id === '') return fail('Missing delegation.');
  try {
    await revokeDelegation(session, id);
  } catch (error) {
    return fail(describeError(error, 'manage delegations'));
  }
  revalidatePath(PATH);
  return ok('Delegation revoked.');
}
