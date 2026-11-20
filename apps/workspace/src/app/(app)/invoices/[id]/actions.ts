'use server';

import { randomUUID } from 'node:crypto';

import { formatCustomerDate } from '@bos/locale';

import { NO_APPROVER_MESSAGE } from '@/components/p2/quote-builder/failure';
import { ApiError } from '@/lib/api';
import {
  describeBillingFailure,
  discardInvoice,
  issueInvoice,
  issueOutcomeMessage,
  keyAfterFailure,
  submitInvoice,
} from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

/**
 * Submit, issue and discard one invoice. Serves the NFR "no double issue, no double decision": each
 * form carries an Idempotency-Key that the page generated once per render, and `expectedVersion`,
 * the `version` of the invoice row the person actually looked at, so a stale click is refused with
 * 409 instead of acting on a document that has moved.
 *
 * The key is kept after an unknown outcome (timeout, 5xx) and after the in-progress 409, and rotated
 * only after a final answer, by the billing client's `keyAfterFailure`. Issuing an invoice that is
 * already issued is a success (`already_issued`), never an error. Nothing here computes an amount, a
 * number or a date: the server sets all three.
 *
 * Every action returns `done` with a toast message; closing its dialog reloads the page.
 * This file exports only async functions and types: a Server Actions file cannot export values.
 */

export interface InvoiceActionState {
  /** The key the next submit will use. */
  key: string;
  error?: string;
  /** The page is out of date: offer a reload. */
  reload?: boolean;
  /** One sentence per wrong field; the request never reached the API. */
  errors?: { reason?: string };
  /** The API accepted the request. */
  done?: boolean;
  /** What to tell the person once `done`. */
  message?: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;
const REASON_MAX = 1000;

const BROKEN: Pick<InvoiceActionState, 'error' | 'reload'> = {
  error: 'This form is incomplete. Reload the page.',
  reload: true,
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

interface Ctx {
  session: Session;
  id: string;
  expectedVersion: number;
}

/**
 * What every action does first: check the id and the version, take the page's key, then call the API.
 * Validation never reaches the API, so the same key is still unused afterwards.
 */
async function run(
  prev: InvoiceActionState,
  form: FormData,
  send: (ctx: Ctx, key: string) => Promise<string>,
  words?: (err: unknown) => string | undefined,
): Promise<InvoiceActionState> {
  const id = text(form, 'invoiceId');
  const versionText = text(form, 'expectedVersion');
  const expectedVersion = /^\d{1,9}$/.test(versionText) ? Number(versionText) : 0;
  if (!UUID.test(id) || expectedVersion < 1) return { key: prev.key, ...BROKEN };

  const session = await requireStaffSession(`/invoices/${id}`);
  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : randomUUID();

  try {
    const message = await send({ session, id, expectedVersion }, key);
    return { key, done: true, message };
  } catch (err) {
    const failure = describeBillingFailure(err);
    return {
      key: keyAfterFailure(err, key),
      error: words?.(err) ?? failure.message,
      ...(failure.reload ? { reload: true } : {}),
    };
  }
}

/** `POST /v1/invoices/:id/submit`: send a draft or returned invoice to the approvers. */
export async function submitInvoiceAction(
  prev: InvoiceActionState,
  form: FormData,
): Promise<InvoiceActionState> {
  return run(
    prev,
    form,
    async (c, key) => {
      await submitInvoice(c.session, c.id, { expectedVersion: c.expectedVersion }, key);
      return 'Submitted for approval.';
    },
    // The body is only the version, so a 422 here is the route refusing: nobody can approve.
    (err) => (err instanceof ApiError && err.status === 422 ? NO_APPROVER_MESSAGE : undefined),
  );
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** The issue refusals the billing client would word generically, in the invoice's own terms. */
function issueRefusal(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.status !== 422) return undefined;
  const error = (err.body as { error?: { code?: unknown; details?: Record<string, unknown> } })
    ?.error;
  if (error?.code !== 'DUE_DATE_BEFORE_ISSUE') return undefined;
  // Only a plain date is echoed from `details`.
  const due = error.details?.['dueDate'];
  const when = typeof due === 'string' && ISO_DAY.test(due) ? ` (${formatCustomerDate(due)})` : '';
  return `The due date${when} is before today, so this invoice cannot be issued. An invoice is issued with a due date of today or later.`;
}

/** `POST /v1/invoices/:id/issue`: both `issued` and `already_issued` are a success. */
export async function issueInvoiceAction(
  prev: InvoiceActionState,
  form: FormData,
): Promise<InvoiceActionState> {
  return run(
    prev,
    form,
    async (c, key) =>
      issueOutcomeMessage(
        await issueInvoice(c.session, c.id, { expectedVersion: c.expectedVersion }, key),
      ),
    issueRefusal,
  );
}

/** `POST /v1/invoices/:id/discard`: the reason is required, and an empty one never reaches the API. */
export async function discardInvoiceAction(
  prev: InvoiceActionState,
  form: FormData,
): Promise<InvoiceActionState> {
  const reason = text(form, 'reason').trim();
  if (reason === '' || reason.length > REASON_MAX) {
    const submitted = text(form, 'idempotencyKey');
    return {
      key: KEY.test(submitted) ? submitted : prev.key,
      errors: {
        reason:
          reason === ''
            ? 'Say why this invoice is being discarded.'
            : `Keep the reason under ${REASON_MAX} characters.`,
      },
    };
  }
  return run(prev, form, async (c, key) => {
    await discardInvoice(c.session, c.id, { expectedVersion: c.expectedVersion, reason }, key);
    return 'Discarded.';
  });
}
