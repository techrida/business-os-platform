'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createMemo, failureOf, submitMemo, updateMemo } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { memoDraftAccount, readDraft, tombstoneDraft } from '@/lib/memo-working-draft';
import { REVISION_PATTERN, type MemoDraftScopeId } from '@/lib/memo-working-draft-types';
import type { Session } from '@/lib/session';

import { readValues, text, validateMemo, type MemoFormState } from './memo-values';

/**
 * Server actions for the internal memo: create, edit and submit. Every one validates
 * on the server (the browser's checks are a courtesy) and asks `requireStaffSession` first, so an
 * expired session goes to sign-in and comes back to the right page.
 */

export type { MemoFormState, MemoValues } from './memo-values';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shown when an editor left open in one account is submitted after another account signed in on the same browser. */
const ACCOUNT_CHANGED = 'The signed-in account changed. Reload this page to continue.';

/**
 * The form carries the account binding it was rendered with. A stale tab from another account must not create or
 * update a memo as whoever signed in since, so the binding is compared with the session in hand, before anything
 * else. A missing binding counts as a mismatch.
 */
function accountMatches(session: Session, form: FormData): boolean {
  return text(form, 'draftAccount') === memoDraftAccount(session);
}

/**
 * After a memo is really created or saved, its working draft is deleted (a tombstone, so a late autosave from another
 * tab cannot bring it back). A newer working copy belongs to a different edit and stays available.
 */
async function clearWorkingDraft(
  session: Session,
  scopeId: MemoDraftScopeId,
  form: FormData,
): Promise<void> {
  const sent = text(form, 'draftRevision');
  const owner = { orgId: session.orgId, sub: session.sub };
  try {
    await tombstoneDraft(owner, scopeId, REVISION_PATTERN.test(sent) ? sent : null);
  } catch {
    // Best effort: see above.
  }
}

export async function createMemoAction(
  _prev: MemoFormState,
  form: FormData,
): Promise<MemoFormState> {
  const session = await requireStaffSession('/memos/new');
  const values = readValues(form);
  if (!accountMatches(session, form)) return { values, fieldErrors: {}, error: ACCOUNT_CHANGED };
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
  await clearWorkingDraft(session, null, form);
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
  if (!accountMatches(session, form)) return { values, fieldErrors: {}, error: ACCOUNT_CHANGED };
  const expectedVersion = Number(text(form, 'expectedVersion'));
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { values, fieldErrors: {}, error: 'Reload this memo before saving changes.' };
  }
  const checked = validateMemo(values);
  if (!checked.ok)
    return {
      values,
      fieldErrors: checked.fieldErrors,
      error: 'Check all memo fields and choose different people for each role.',
    };

  try {
    await updateMemo(session, memoId, { ...checked.data, expectedVersion });
  } catch (err) {
    const f = failureOf(err);
    return {
      values,
      fieldErrors: {},
      error:
        f.status === 409
          ? 'This memo changed. Reload it and review your changes before saving.'
          : f.message,
    };
  }
  await clearWorkingDraft(session, memoId.toLowerCase(), form);
  revalidatePath(`/memos/${memoId}`);
  return { values, fieldErrors: {}, savedTo: `/memos/${memoId}?saved=1` };
}

export interface SubmitState {
  error?: string;
}

export async function submitMemoAction(_prev: SubmitState, form: FormData): Promise<SubmitState> {
  const memoId = text(form, 'memoId');
  if (!UUID.test(memoId)) return { error: 'This form is incomplete. Reload the page.' };
  const session = await requireStaffSession(`/memos/${memoId}`);
  const expectedVersion = Number(text(form, 'expectedVersion'));
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
    return { error: 'Reload this memo before submitting.' };
  }

  // Submitting approves the saved memo. If this account holds a working copy with changes that were never saved into
  // the memo, the person is looking at something else than what would go for approval: ask them to review first.
  // The copy is stored under the caller's own identity, so someone who cannot edit the memo has none and is not
  // held up. If the draft store cannot answer, the submit is refused too: the store shares Valkey with sessions, so a
  // real outage has already stopped the session check, and "unknown" must not be read as "no changes".
  try {
    const draft = await readDraft({ orgId: session.orgId, sub: session.sub }, memoId.toLowerCase());
    if (draft.values !== null)
      return { error: 'Your edits are not saved yet. Press Done, then submit.' };
  } catch {
    return { error: 'Your changes could not be checked right now. Try again in a moment.' };
  }

  let status: 'pending' | 'blocked';
  try {
    status = (await submitMemo(session, memoId, expectedVersion)).status;
  } catch (err) {
    return { error: failureOf(err, 'submit').message };
  }
  revalidatePath(`/memos/${memoId}`);
  redirect(`/memos/${memoId}?submitted=${status}`);
}
