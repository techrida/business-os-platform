'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { nextKey } from '@/components/p2/crm/idempotency';
import { decideVerification } from '@/components/p2/customers/api';
import { isGuid, parseDecision } from '@/components/p2/customers/format';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';

/**
 * The approve and reject action for a KYB case. Like the approval inbox it carries an
 * Idempotency-Key (made once per page render) and `expectedVersion`, the case version the
 * reviewer actually looked at, so a stale click is refused with 409 instead of deciding on
 * information that has moved. Permission is enforced by the API (`verification.review`); the page
 * only decides whether to show the form.
 */

export interface ReviewState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  commentError?: string;
}

/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function reviewAction(prev: ReviewState, form: FormData): Promise<ReviewState> {
  const caseId = text(form, 'caseId');
  if (!isGuid(caseId)) {
    return { key: prev.key, error: 'This form is incomplete. Reload the page.', reload: true };
  }

  const session = await requireStaffSession(`/verification/${caseId}`);

  const submittedKey = text(form, 'idempotencyKey');
  const key = KEY.test(submittedKey) ? submittedKey : randomUUID();

  const parsed = parseDecision({
    decision: text(form, 'intent'),
    comment: text(form, 'comment'),
    expectedVersion: text(form, 'expectedVersion'),
  });
  if (!parsed.ok) {
    // Validation failures never reach the API, so the same key is still unused.
    return 'commentError' in parsed
      ? { key, commentError: parsed.commentError }
      : { key, error: 'This form is incomplete. Reload the page and try again.', reload: true };
  }

  try {
    await decideVerification(session, caseId, parsed.data, key);
  } catch (err) {
    const failure = failureOf(err);
    return {
      // A 4xx is a final answer (this click is over), so the next try is a new decision. After a
      // timeout, a 5xx or the 409 "this key is still being processed" the first call may have
      // landed: send the same key so it cannot apply twice.
      key: nextKey(err, key),
      error: failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }

  revalidatePath('/verification');
  revalidatePath(`/verification/${caseId}`);
  return { key: randomUUID() };
}
