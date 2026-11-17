'use server';

import { randomUUID } from 'node:crypto';

import { AttachVerificationDocumentBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { UUID } from '@/components/p2/crm/action-helpers';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import { kybFailure } from '@/components/p2/crm/kyb-failure';
import {
  attachChecklistDocument,
  openVerificationCase,
  submitVerificationCase,
} from '@/components/p2/crm/verification-api';
import { CHECKLIST_LABEL } from '@/components/p2/customers/format';
import { requireStaffSession } from '@/lib/bff';

/**
 * Server actions that put a customer's documents through KYB: open a case, attach documents, submit.
 * Each asks `requireStaffSession` first (an expired session goes to sign-in and comes back) and
 * sends an Idempotency-Key that the form carries, so a double click or a retry after a timeout
 * names the same request. The API enforces `customer.write`; the pages only decide what to show.
 */

/** What every KYB form gets back: the key its next submit will use, and what went wrong. */
export interface CaseFormState {
  /** Rotated after a definite refusal or a success, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
}

export type OpenCaseState = CaseFormState;

export async function openCaseAction(_prev: OpenCaseState, form: FormData): Promise<OpenCaseState> {
  const idValue = form.get('partyId');
  const partyId = typeof idValue === 'string' ? idValue : '';
  const key = keyOf(form);
  if (!UUID.test(partyId)) {
    return { key, error: 'This form is incomplete. Reload the page.', reload: true };
  }
  const session = await requireStaffSession(`/customers/${partyId}`);

  let caseId: string;
  try {
    caseId = (await openVerificationCase(session, partyId, key)).id;
  } catch (err) {
    const f = kybFailure(err, 'open');
    return { key: nextKey(err, key), error: f.message, ...(f.reload ? { reload: true } : {}) };
  }
  revalidatePath('/verification');
  revalidatePath(`/customers/${partyId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect(`/verification/${caseId}`);
}

export interface AttachDocumentState extends CaseFormState {
  /** The checklist item the document went onto, in words. Set only on success. */
  attached?: string;
  /** Set when the API said the uploaded file is not this case's: the form must upload it again. */
  reupload?: true;
}

/**
 * Puts one already-uploaded document on one checklist item (the file went through the upload route
 * first). Draft or rejected only; on a rejected case the API sends the case back to a draft. Stays
 * on the page: the form refreshes it, and a failed call keeps the uploaded file for the retry.
 */
export async function attachDocumentAction(
  _prev: AttachDocumentState,
  form: FormData,
): Promise<AttachDocumentState> {
  const text = (name: string): string => {
    const v = form.get(name);
    return typeof v === 'string' ? v : '';
  };
  const caseId = text('caseId');
  const key = keyOf(form);
  // A date input sends an empty string when it was left blank: that means "no expiry", not a bad date.
  const expiresOn = text('expiresOn');
  const body = AttachVerificationDocumentBodySchema.safeParse({
    key: text('key'),
    documentId: text('documentId'),
    ...(expiresOn !== '' ? { expiresOn } : {}),
    expectedVersion: Number(text('expectedVersion')),
  });
  if (!UUID.test(caseId) || !body.success) {
    return { key, error: 'This form is incomplete. Reload the page.', reload: true };
  }
  const session = await requireStaffSession(`/verification/${caseId}`);

  try {
    await attachChecklistDocument(session, caseId, body.data, key);
  } catch (err) {
    const f = kybFailure(err, 'attach');
    const refused = (err as { status?: unknown } | null)?.status === 422;
    return {
      key: nextKey(err, key),
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
      ...(refused ? { reupload: true as const } : {}),
    };
  }
  // The queue lists the status too: attaching on a rejected case reopens it as a draft.
  revalidatePath('/verification');
  revalidatePath(`/verification/${caseId}`);
  return { key: randomUUID(), attached: CHECKLIST_LABEL[body.data.key] };
}

export type SubmitCaseState = CaseFormState;

/** Draft to submitted. The reviewer sees exactly the files that are on the case now. */
export async function submitCaseAction(
  _prev: SubmitCaseState,
  form: FormData,
): Promise<SubmitCaseState> {
  const idValue = form.get('caseId');
  const caseId = typeof idValue === 'string' ? idValue : '';
  const key = keyOf(form);
  if (!UUID.test(caseId)) {
    return { key, error: 'This form is incomplete. Reload the page.', reload: true };
  }
  const session = await requireStaffSession(`/verification/${caseId}`);

  try {
    await submitVerificationCase(session, caseId, key, Number(form.get('expectedVersion')));
  } catch (err) {
    const f = kybFailure(err, 'submit');
    return { key: nextKey(err, key), error: f.message, ...(f.reload ? { reload: true } : {}) };
  }
  revalidatePath('/verification');
  revalidatePath(`/verification/${caseId}`);
  // `redirect` throws, so it stays outside the try block. The page shows a confirmation.
  redirect(`/verification/${caseId}?submitted=1`);
}
