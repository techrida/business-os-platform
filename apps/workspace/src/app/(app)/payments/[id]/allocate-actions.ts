'use server';

import { randomUUID } from 'node:crypto';

import { PositiveDecimalString } from '@bos/contracts';
import { NO_SPACES, hasInnerSpace } from '@bos/locale';
import { revalidatePath } from 'next/cache';

import { allocatePayment, deallocate } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';

import { describePaymentFailure } from '../_lib/failure';

/**
 * Allocate a verified payment to open invoices, and undo one allocation. Serves plan A8 (what is
 * paid or open is the server's call): this file never adds amounts up or compares them with what an
 * invoice has open or what the payment has left. It only checks that each amount is "a positive
 * number with at most 2 decimals" (the contract's own rule), then the server refuses OVER_ALLOCATION
 * and MISMATCHED_ITEMS in words `describePaymentFailure` already has.
 *
 * Key rule (same as the review actions): a definite answer (any 4xx other than the in-progress 409)
 * ends this click, so the next try is a new decision with a new key. A timeout, a 5xx or the 409
 * "first request still running" may have landed, so the same key goes again and the API replays it.
 * A form refused here never reached the API, so its key is unused and is kept. An accepted allocation
 * hands back a fresh key: the panel stays on screen, and the next allocation is a new decision that
 * must not replay the first one.
 */

export interface AllocateState {
  /** The key the next submit will use. */
  key: string;
  error?: string;
  /** Set when the page is out of date and the person should reload it. */
  reload?: boolean;
  /** Words per wrong field; the request never reached the API. `lines` is keyed by invoice id. */
  errors?: { form?: string; lines?: Record<string, string>; reason?: string };
  /** The API accepted the request. */
  done?: boolean;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9-]{8,64}$/;
const LINE_PREFIX = 'amount:';
const MAX_LINES = 50;

const BROKEN: Pick<AllocateState, 'error' | 'reload'> = {
  error: 'This form is incomplete. Reload the page.',
  reload: true,
};

const AMOUNT_WORDS = 'Enter a positive number with up to 2 decimals, for example 1500.00.';
const NO_LINES_WORDS = 'Enter an amount for at least one invoice.';
const TOO_MANY_WORDS = `Allocate to at most ${MAX_LINES} invoices at a time.`;
const REASON_REQUIRED = 'Say why. The reason is kept with the allocation.';
const REASON_TOO_LONG = 'Keep the reason under 1,000 characters.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function keyOf(form: FormData): string {
  const submitted = text(form, 'idempotencyKey');
  return KEY.test(submitted) ? submitted : randomUUID();
}

/** The state after the API refused or did not answer; see the key rule above. */
function refused(err: unknown, key: string): AllocateState {
  const failure = describePaymentFailure(err);
  return {
    key: failure.definite ? randomUUID() : key,
    error: failure.message,
    ...(failure.reload ? { reload: true } : {}),
  };
}

/** `POST /v1/payments/:id/allocations`: one line per invoice that has an amount typed in. */
export async function allocateAction(prev: AllocateState, form: FormData): Promise<AllocateState> {
  const paymentId = text(form, 'paymentId');
  if (!UUID.test(paymentId)) return { key: prev.key, ...BROKEN };

  // Fields are `amount:<invoiceId>`. Blank inputs are skipped: nothing typed means no line.
  const lines: { invoiceId: string; amount: string }[] = [];
  const wrong: Record<string, string> = {};
  for (const [name, value] of form.entries()) {
    if (!name.startsWith(LINE_PREFIX) || typeof value !== 'string') continue;
    const invoiceId = name.slice(LINE_PREFIX.length);
    if (!UUID.test(invoiceId)) return { key: prev.key, ...BROKEN };
    const amount = value.trim();
    if (amount === '') continue;
    if (PositiveDecimalString.safeParse(amount).success) lines.push({ invoiceId, amount });
    // "10 50" is not 1050; the digits look fine to the person, so name the space.
    else wrong[invoiceId] = hasInnerSpace(amount) ? NO_SPACES : AMOUNT_WORDS;
  }

  const session = await requireStaffSession(`/payments/${paymentId}`);
  const key = keyOf(form);

  if (Object.keys(wrong).length > 0) return { key, errors: { lines: wrong } };
  if (lines.length === 0) return { key, errors: { form: NO_LINES_WORDS } };
  if (lines.length > MAX_LINES) return { key, errors: { form: TOO_MANY_WORDS } };

  try {
    await allocatePayment(session, paymentId, { lines }, key);
  } catch (err) {
    return refused(err, key);
  }
  revalidatePath(`/payments/${paymentId}`);
  revalidatePath('/payments');
  return { key: randomUUID(), done: true };
}

/**
 * `POST /v1/payments/:id/allocations/:allocationId/reverse`: a deallocation is a reversal row, and
 * the reason is required. The body is the reason alone (the contract rejects anything else).
 */
export async function deallocateAction(
  prev: AllocateState,
  form: FormData,
): Promise<AllocateState> {
  const paymentId = text(form, 'paymentId');
  const allocationId = text(form, 'allocationId');
  if (!UUID.test(paymentId) || !UUID.test(allocationId)) return { key: prev.key, ...BROKEN };
  const session = await requireStaffSession(`/payments/${paymentId}`);
  const key = keyOf(form);

  const reason = text(form, 'reason').trim();
  if (reason === '') return { key, errors: { reason: REASON_REQUIRED } };
  if (reason.length > 1000) return { key, errors: { reason: REASON_TOO_LONG } };

  try {
    await deallocate(session, paymentId, allocationId, { reason }, key);
  } catch (err) {
    return refused(err, key);
  }
  revalidatePath(`/payments/${paymentId}`);
  revalidatePath('/payments');
  return { key, done: true };
}
