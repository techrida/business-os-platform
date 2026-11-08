'use server';

import { randomUUID } from 'node:crypto';

import { ApprovalActionBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { actOnApproval, failureOf } from '@/lib/api-kernel';
import { isStepUpRequired, redirectToStepUp, requireStaffSession } from '@/lib/bff';

/**
 * The approve, return and reject action. Serves the NFR "no double decisions": the form carries an
 * Idempotency-Key that the page generated once per render, and `expectedVersion`, the request
 * version the approver actually looked at, so a stale click is refused with 409 instead of
 * deciding on information that has moved.
 */

export interface DecisionState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  commentError?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

const COMMENT_PROMPT: Record<string, string> = {
  return: 'Say what needs to change, so the person who prepared it knows what to fix.',
  reject: 'Say why you are rejecting it. The reason is kept in the audit trail.',
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

export async function decideAction(prev: DecisionState, form: FormData): Promise<DecisionState> {
  const requestId = text(form, 'requestId');
  if (!UUID.test(requestId))
    return { key: prev.key, error: 'This form is incomplete. Reload the page.', reload: true };

  const session = await requireStaffSession(`/inbox/${requestId}`);

  const submittedKey = text(form, 'idempotencyKey');
  const key = KEY.test(submittedKey) ? submittedKey : randomUUID();
  const intent = text(form, 'intent');
  const comment = text(form, 'comment').trim();

  const parsed = ApprovalActionBodySchema.safeParse({
    action: intent,
    ...(comment !== '' ? { comment } : {}),
    expectedVersion: Number(text(form, 'expectedVersion')),
  });
  if (!parsed.success) {
    // Validation failures never reach the API, so the same key is still unused.
    const needsComment = (intent === 'return' || intent === 'reject') && comment === '';
    return needsComment
      ? { key, commentError: COMMENT_PROMPT[intent] ?? 'A comment is required.' }
      : { key, error: 'This form is incomplete. Reload the page and try again.', reload: true };
  }

  try {
    await actOnApproval(session, requestId, parsed.data, key);
  } catch (err) {
    // K7: a Founder step needs a recent sign-in. Nothing was decided, so after signing in again the
    // approver lands back on this request and decides with a fresh form. `redirect` throws.
    if (isStepUpRequired(err)) redirectToStepUp(`/inbox/${requestId}`);
    const failure = failureOf(err, 'approval');
    return {
      // A 4xx is a final answer (this click is over), so the next try is a new decision. After a
      // timeout or 5xx the first call may have landed: send the same key so it cannot apply twice.
      key: failure.definite ? randomUUID() : key,
      error: failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }

  revalidatePath('/inbox');
  // `redirect` throws, so it stays outside the try block. The inbox shows a confirmation.
  redirect(`/inbox?decided=${parsed.data.action}`);
}
