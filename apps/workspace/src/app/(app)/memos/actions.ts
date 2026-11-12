'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createMemo, failureOf, submitMemo, updateMemo } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

import { readValues, text, validateMemo, type MemoFormState } from './memo-values';

/**
 * Server actions for the internal memo: create, edit and submit. Every one validates
 * on the server (the browser's checks are a courtesy) and asks `requireStaffSession` first, so an
 * expired session goes to sign-in and comes back to the right page.
 */

export type { MemoFormState, MemoValues } from './memo-values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function createMemoAction(
  _prev: MemoFormState,
  form: FormData,
): Promise<MemoFormState> {
  const session = await requireStaffSession('/memos/new');
  const values = readValues(form);
  const checked = validateMemo(values);
  if (!checked.ok)
    return {
      values,
      fieldErrors: checked.fieldErrors,
      error: 'Check all memo fields and choose different people for each role.',
    };

  let id: string;
  try {
    id = (await createMemo(session, checked.data)).id;
  } catch (err) {
    return { values, fieldErrors: {}, error: failureOf(err).message };
  }
  revalidatePath('/memos');
  redirect(`/memos/${id}`);
}

export async function updateMemoAction(
  _prev: MemoFormState,
  form: FormData,
): Promise<MemoFormState> {
  const memoId = text(form, 'memoId');
  const values = readValues(form);
  if (!UUID.test(memoId)) {
    return { values, fieldErrors: {}, error: 'This form is incomplete. Reload the page.' };
  }
  const session = await requireStaffSession(`/memos/${memoId}`);
  const checked = validateMemo(values);
  if (!checked.ok)
    return {
      values,
      fieldErrors: checked.fieldErrors,
      error: 'Check all memo fields and choose different people for each role.',
    };

  try {
    await updateMemo(session, memoId, checked.data);
  } catch (err) {
    const f = failureOf(err);
    return {
      values,
      fieldErrors: {},
      error:
        f.status === 409
          ? 'This memo can only be edited while it is a draft or returned. Reload to see where it stands.'
          : f.message,
    };
  }
  revalidatePath(`/memos/${memoId}`);
  redirect(`/memos/${memoId}?saved=1`);
}

export interface SubmitState {
  error?: string;
}

export async function submitMemoAction(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const memoId = text(form, 'memoId');
  if (!UUID.test(memoId)) return { error: 'This form is incomplete. Reload the page.' };
  const session = await requireStaffSession(`/memos/${memoId}`);

  let status: 'pending' | 'blocked';
  try {
    status = (await submitMemo(session, memoId)).status;
  } catch (err) {
    return { error: failureOf(err, 'submit').message };
  }
  revalidatePath(`/memos/${memoId}`);
  redirect(`/memos/${memoId}?submitted=${status}`);
}
