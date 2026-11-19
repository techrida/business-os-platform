'use server';

import { randomUUID } from 'node:crypto';

import { RequestPaymentBodySchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import { hasPermission } from '@/components/p2/customers/permissions';
import {
  cancelPaymentRequest,
  createPaymentRequest,
  submitPaymentRequest,
} from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';

import { parseReason } from '../../procurement/orders/_lib/forms';
import type { ActionState } from '../../procurement/orders/_lib/state';
import { paymentRequestFailure } from './failure';

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
  if (!hasPermission(session.roles, 'payables.payment.request'))
    return { key, error: noPermission };
  const count = Number(text(form, 'lineCount'));
  if (!Number.isInteger(count) || count < 1 || count > 200)
    return { key, error: 'Add between 1 and 200 payable items.' };
  const purchaseOrderId = text(form, 'purchaseOrderId');
  const parsed = RequestPaymentBodySchema.safeParse({
    vendorPartyId: text(form, 'vendorPartyId'),
    fromBankAccountId: text(form, 'fromBankAccountId'),
    currency: text(form, 'currency'),
    paymentType: 'settlement',
    ...(purchaseOrderId === '' ? {} : { purchaseOrderId }),
    allocations: Array.from({ length: count }, (_, i) => ({
      openItemId: text(form, `allocation:${i}:openItemId`),
      amount: text(form, `allocation:${i}:amount`),
    })),
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      errors[issue.path.join('.')] =
        issue.path.at(-1) === 'amount'
          ? 'Enter an amount above zero, with up to two decimal places.'
          : issue.path.at(-1) === 'currency'
            ? 'Choose a currency.'
            : 'Enter a valid ID.';
    }
    return { key, errors };
  }
  let id: string;
  try {
    id = (await createPaymentRequest(session, parsed.data, key)).id;
  } catch (err) {
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
