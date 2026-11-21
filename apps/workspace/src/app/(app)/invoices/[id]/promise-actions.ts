'use server';

import { randomUUID } from 'node:crypto';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { ApiError } from '@/lib/api';
import { describeBillingFailure, keyAfterFailure } from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';

import { recordInvoicePromise } from './promises-api';

/**
 * Record a promise to pay from the invoice detail. The form carries an Idempotency-Key the page generated once per
 * render; it is kept after a refused field and an unknown outcome, so a double click or a retry after a timeout records
 * one promise, and rotated only after a final answer (`keyAfterFailure`). Recording while a promise is open replaces it
 * on the server (decision R4c1 Q6); nothing here decides that.
 *
 * This file exports only async functions and types: a Server Actions file cannot export values.
 */

export interface PromiseActionState {
  /** The key the next submit will use. */
  key: string;
  error?: string;
  /** The page is out of date: offer a reload. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. */
  errors?: { promisedDate?: string; note?: string };
  done?: boolean;
  message?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY = /^[A-Za-z0-9-]{8,64}$/;
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
const NOTE_MAX = 1000;
const PAST_DAY = 'Choose today or a later date.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** A real calendar day: `2026-02-30` matches the pattern but is not one. */
function isDay(value: string): boolean {
  if (!ISO_DAY.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

/** The refusals the generic wording would get wrong, in the promise's own terms. */
function refusal(err: unknown): Pick<PromiseActionState, 'error' | 'reload' | 'errors'> | null {
  if (!(err instanceof ApiError)) return null;
  const { code, message } =
    (err.body as { error?: { code?: unknown; message?: unknown } } | undefined)?.error ?? {};
  // The body was checked here, so a 400 is the day having passed (midnight in Kathmandu since the dialog opened).
  if (err.status === 400) return { errors: { promisedDate: PAST_DAY } };
  if (err.status === 403) {
    return { error: 'Your roles do not let you record a promise to pay on this invoice.' };
  }
  if (err.status === 409 && code === 'invoice_not_open') {
    return {
      error: 'Nothing is owed on this invoice any more, so it cannot take a promise to pay.',
      reload: true,
    };
  }
  // promise_open has two causes the API words itself: a promise recorded at the same time, or an open promise whose
  // day has passed and is waiting for the hourly missed check. The fallback covers a body without words.
  if (err.status === 409 && code === 'promise_open') {
    return {
      error:
        typeof message === 'string' && message !== ''
          ? message
          : 'Someone recorded a promise on this invoice at the same time. Reload to see it.',
      reload: true,
    };
  }
  return null;
}

/** `POST /v1/receivables/invoices/:id/promises`. */
export async function recordPromiseAction(
  prev: PromiseActionState,
  form: FormData,
): Promise<PromiseActionState> {
  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : prev.key;
  const id = text(form, 'invoiceId');
  if (!UUID.test(id)) {
    return { key, error: 'This form is incomplete. Reload the page.', reload: true };
  }

  const promisedDate = text(form, 'promisedDate').trim();
  const note = text(form, 'note').trim();
  const errors: NonNullable<PromiseActionState['errors']> = {};
  if (!isDay(promisedDate)) errors.promisedDate = 'Choose the date the customer promised to pay.';
  else if (promisedDate < todayInKathmandu()) errors.promisedDate = PAST_DAY;
  if (note.length > NOTE_MAX) errors.note = `Keep the note under ${NOTE_MAX} characters.`;
  if (Object.keys(errors).length > 0) return { key, errors };

  const session = await requireStaffSession(`/invoices/${id}`);
  const sendKey = KEY.test(submitted) ? submitted : randomUUID();
  try {
    // The contract's note is optional with at least one character: a blank one is left out, never sent empty.
    await recordInvoicePromise(
      session,
      id,
      note === '' ? { promisedDate } : { promisedDate, note },
      sendKey,
    );
    return { key: sendKey, done: true, message: 'Promise to pay recorded.' };
  } catch (err) {
    const next = keyAfterFailure(err, sendKey);
    const words = refusal(err);
    if (words !== null) return { key: next, ...words };
    const failure = describeBillingFailure(err);
    return { key: next, error: failure.message, ...(failure.reload ? { reload: true } : {}) };
  }
}
