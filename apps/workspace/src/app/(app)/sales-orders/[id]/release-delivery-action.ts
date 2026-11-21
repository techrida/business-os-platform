'use server';

import { revalidatePath } from 'next/cache';

import { keyOf } from '@/components/p2/crm/idempotency';
import { ApiError, apiFetch } from '@/lib/api';
import { describeBillingFailure, keyAfterFailure } from '@/lib/api-billing';
import { apiCodeOf, apiReasonOf } from '@/lib/api-code';
import { requireStaffSession } from '@/lib/bff';

import { isGuid } from '../_lib/status';

/** What the release form gets back. Types only cross this file, so the `'use server'` rule holds. */
export interface ReleaseDeliveryState {
  key: string;
  error?: string;
  reload?: boolean;
  errors?: { reason?: string };
  done?: boolean;
}

const MAX_REASON = 1000;

async function bodyOf(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/**
 * Words for a refusal. The API's 403 here carries no reason the error filter lets through, so it cannot say
 * whether the caller created the order or the threshold moved; either way a reload shows the current rule.
 * An already released order comes back as `delivery_already_released`.
 */
function refused(err: unknown, key: string): ReleaseDeliveryState {
  const next = keyAfterFailure(err, key);
  const status = err instanceof ApiError ? err.status : 0;
  // The small-team rule (F1-Q11 a): the only person who may release must say why, so it lands on the field.
  if (status === 400 && apiReasonOf(err) === 'sole_eligible_reason_required') {
    return {
      key: next,
      errors: {
        reason:
          'You are the only person who can release this delivery, so say why it is released now.',
      },
    };
  }
  // An allow-listed reason (no_permission, out_of_scope ...) gets the kernel's words below.
  if (status === 403 && apiReasonOf(err) === undefined) {
    return {
      key: next,
      reload: true,
      error:
        'You cannot release this delivery: you created this order, or your role cannot release an order of this amount. Reload this page to see who can.',
    };
  }
  const failure = describeBillingFailure(err);
  const code = status === 409 && failure.kind !== 'in_progress' ? apiCodeOf(err) : undefined;
  if (code === 'sales_order_not_open' || code === 'delivery_already_released') {
    return {
      key: next,
      reload: true,
      error:
        code === 'sales_order_not_open'
          ? 'This order is no longer confirmed, so its delivery cannot be released.'
          : 'This delivery was already released. Reload this page to see who released it.',
    };
  }
  return { key: next, error: failure.message, ...(failure.reload ? { reload: true } : {}) };
}

/**
 * `POST /v1/sales-orders/:id/delivery-release` with the reason. The Idempotency-Key is the one the page generated
 * for this render: a timeout or the in-progress 409 keeps it, a final refusal rotates it.
 */
export async function releaseDeliveryAction(
  _prev: ReleaseDeliveryState,
  form: FormData,
): Promise<ReleaseDeliveryState> {
  const key = keyOf(form);
  const id = form.get('salesOrderId');
  if (typeof id !== 'string' || !isGuid(id)) {
    return { key, reload: true, error: 'This page is out of date. Reload it and try again.' };
  }
  const raw = form.get('reason');
  const reason = typeof raw === 'string' ? raw.trim() : '';
  if (reason === '') return { key, errors: { reason: 'Say why the delivery is released now.' } };
  if (reason.length > MAX_REASON) {
    return { key, errors: { reason: `Keep the reason to ${MAX_REASON} characters or fewer.` } };
  }

  const path = `/sales-orders/${encodeURIComponent(id)}`;
  const session = await requireStaffSession(path);
  try {
    const res = await apiFetch(session, `/v1${path}/delivery-release`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify({ reason }),
    });
    if (!res.ok) {
      throw new ApiError(
        res.status,
        `POST /v1/sales-orders/:id/delivery-release failed with ${res.status}`,
        await bodyOf(res),
      );
    }
  } catch (err) {
    return refused(err, key);
  }
  revalidatePath(path);
  return { key, done: true };
}
