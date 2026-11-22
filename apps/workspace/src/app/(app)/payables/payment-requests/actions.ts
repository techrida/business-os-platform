'use server';

import { randomUUID } from 'node:crypto';

import { RequestPaymentBodySchema } from '@bos/contracts';
import { hasInnerSpace, NO_SPACES } from '@bos/locale';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  cancelPaymentRequest,
  createPaymentRequest,
  submitPaymentRequest,
} from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { parseReason } from '../../procurement/orders/_lib/forms';
import type { ActionState } from '../../procurement/orders/_lib/state';
import { paymentRequestFailure, paymentRequestFieldError } from './failure';
import { readPaymentRequestForm } from './model';

const BASE = '/payables/payment-requests';
const text = (form: FormData, name: string) => {
  const value = form.get(name);
  return typeof value === 'string' ? value.trim() : '';
};
const noPermission =
  'Your roles do not allow payment requests. Ask an administrator if you need access.';
const incomplete = 'This form is incomplete. Reload the page and try again.';
const refused = (key: string, err: unknown): ActionState => {
  const failure = paymentRequestFailure(err);
  return {
    key: failure.definite ? randomUUID() : key,
    error: failure.message,
    ...(failure.reload ? { reload: true } : {}),
  };
};

export async function createPaymentRequestAction(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const key = keyOf(form);
  const session = await requireStaffSession(`${BASE}/new`);
  // Live grants, as the entry page is gated on: a grant at any scope, `own` included, may make a request.
  if (!hasGrant(await getGrants(session), 'payables.payment.request'))
    return { key, error: noPermission };
  const { lineCount, allocations, body } = readPaymentRequestForm(form);
  if (lineCount === null) return { key, error: 'Add between 1 and 200 payable items.' };
  const parsed = RequestPaymentBodySchema.safeParse(body);
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      // "10 50" is not 1050: a space inside the amount gets its own sentence.
      const typed = allocations[Number(issue.path[1])]?.amount ?? '';
      errors[issue.path.join('.')] =
        issue.path.at(-1) === 'amount'
          ? hasInnerSpace(typed)
            ? NO_SPACES
            : 'Enter an amount above zero, with up to two decimal places.'
          : issue.path.at(-1) === 'currency'
            ? 'Choose a currency.'
            : issue.path.at(-1) === 'fromBankAccountId'
              ? 'Choose the bank account to pay from.'
              : 'Enter a valid ID.';
    }
    return { key, errors };
  }
  let id: string;
  try {
    id = (await createPaymentRequest(session, parsed.data, key)).id;
  } catch (err) {
    // A refused paying account is shown under its field. A 422 is a final answer: the next try gets a new key.
    const field = paymentRequestFieldError(err);
    if (field !== undefined) return { key: randomUUID(), errors: { [field.field]: field.message } };
    return refused(key, err);
  }
  revalidatePath(BASE);
  redirect(`${BASE}/${encodeURIComponent(id)}`);
}

async function change(
  prev: ActionState,
  form: FormData,
  op: 'submit' | 'cancel',
): Promise<ActionState> {
  const id = text(form, 'requestId');
  const key = keyOf(form);
  if (!isGuid(id)) return { key: prev.key, error: incomplete, reload: true };
  const session = await requireStaffSession(`${BASE}/${id}`);
  // Live grants, as the request's page that holds these buttons is gated on.
  if (!hasGrant(await getGrants(session), 'payables.payment.request'))
    return { key, error: noPermission };
  const reason = parseReason(text(form, 'reason'));
  if (op === 'cancel' && !reason.ok) return { key, errors: { reason: reason.error } };
  try {
    if (op === 'submit') await submitPaymentRequest(session, id, key);
    else if (reason.ok) await cancelPaymentRequest(session, id, reason.data, key);
  } catch (err) {
    return refused(key, err);
  }
  revalidatePath(BASE);
  revalidatePath(`${BASE}/${id}`);
  return {
    key: randomUUID(),
    done:
      op === 'submit'
        ? 'The request was sent to the approvals inbox. Approval records the instruction to pay; it does not send money.'
        : 'The draft payment request was cancelled. No money was sent.',
  };
}

export async function submitPaymentRequestAction(prev: ActionState, form: FormData) {
  return change(prev, form, 'submit');
}
export async function cancelPaymentRequestAction(prev: ActionState, form: FormData) {
  return change(prev, form, 'cancel');
}
