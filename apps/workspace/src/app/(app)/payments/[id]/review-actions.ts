'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';

import { rejectPayment, reversePayment, verifyPayment } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

import { describePaymentFailure } from '../_lib/failure';

/**
 * Verify, reject and reverse a payment. Serves the NFR "no double decisions": each form carries an
 * Idempotency-Key the page generated once per render, and `expectedVersion`, the `version` of the
 * payment the person actually looked at, so a stale click is refused with 409 instead of acting on
 * information that has moved.
 *
 * Key rule: a definite answer (a 4xx such as the self-verification 403 or a stale version) ends this
 * click, so the next try is a new decision with a new key. After a timeout, a 5xx or the 409 that
 * says the first request is still running, the first call may have landed: the same key goes again,
 * so the API replays it instead of applying it twice. A form that fails validation never reaches the
 * API, so its key is still unused and is kept.
 */

export interface ReviewState {
  /** The key the next submit will use. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. */
  errors?: { reason?: string };
  /** The API accepted the request. */
  done?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9-]{8,64}$/;

const BROKEN: Pick<ReviewState, 'error' | 'reload'> = {
  error: 'This form is incomplete. Reload the page.',
  reload: true,
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

const REASON_REQUIRED = 'Say why. The reason is kept with the payment.';
const REASON_TOO_LONG = 'Keep the reason under 1,000 characters.';

interface Ctx {
  session: Session;
  paymentId: string;
  expectedVersion: number;
  reason: string;
}

async function run(
  prev: ReviewState,
  form: FormData,
  needsReason: boolean,
  send: (ctx: Ctx, key: string) => Promise<unknown>,
): Promise<ReviewState> {
  const paymentId = text(form, 'paymentId');
  const version = Number(text(form, 'expectedVersion'));
  if (!UUID.test(paymentId) || !Number.isInteger(version) || version < 1) {
    return { key: prev.key, ...BROKEN };
  }
  const session = await requireStaffSession(`/payments/${paymentId}`);
  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : randomUUID();

  const reason = text(form, 'reason').trim();
  if (needsReason && reason === '') return { key, errors: { reason: REASON_REQUIRED } };
  if (needsReason && reason.length > 1000) return { key, errors: { reason: REASON_TOO_LONG } };

  try {
    await send({ session, paymentId, expectedVersion: version, reason }, key);
  } catch (err) {
    const failure = describePaymentFailure(err);
    return {
      key: failure.definite ? randomUUID() : key,
      error: failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }
  revalidatePath(`/payments/${paymentId}`);
  revalidatePath('/payments');
  return { key, done: true };
}

/** `POST /v1/payments/:id/verify`. The server refuses the person who recorded the payment (403). */
export async function verifyAction(prev: ReviewState, form: FormData): Promise<ReviewState> {
  return run(prev, form, false, (c, key) =>
    verifyPayment(c.session, c.paymentId, { expectedVersion: c.expectedVersion }, key),
  );
}

/** `POST /v1/payments/:id/reject`: a reason is required. */
export async function rejectAction(prev: ReviewState, form: FormData): Promise<ReviewState> {
  return run(prev, form, true, (c, key) =>
    rejectPayment(
      c.session,
      c.paymentId,
      { expectedVersion: c.expectedVersion, reason: c.reason },
      key,
    ),
  );
}

/** `POST /v1/payments/:id/reverse`: a bounced cheque or an erroneous receipt; allocations are undone. */
export async function reverseAction(prev: ReviewState, form: FormData): Promise<ReviewState> {
  return run(prev, form, true, (c, key) =>
    reversePayment(
      c.session,
      c.paymentId,
      { expectedVersion: c.expectedVersion, reason: c.reason },
      key,
    ),
  );
}
