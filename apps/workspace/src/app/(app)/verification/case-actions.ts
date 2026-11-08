'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { UUID } from '@/components/p2/crm/action-helpers';
import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import { kybFailure } from '@/components/p2/crm/kyb-failure';
import { openVerificationCase } from '@/components/p2/crm/verification-api';
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
