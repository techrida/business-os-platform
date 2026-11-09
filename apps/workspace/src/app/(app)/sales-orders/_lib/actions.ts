'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import {
  confirmSalesOrder,
  describeBillingFailure,
  draftInvoiceFromSchedule,
  getSalesOrder,
  keyAfterFailure,
  markScheduleLineBillable,
} from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

import { parseConfirm, parseDraft, parseMarkBillable, type FieldErrors } from './forms';
import { isGuid } from './status';
import type { ActionState } from './state';

/**
 * Confirm an order, mark a schedule line billable, draft an invoice from a line. Serves the NFR "no
 * double documents, no double decisions": each form carries an Idempotency-Key the page generated
 * once per render. A final refusal (4xx) rotates it, because the next click is a new decision. A
 * timeout, a 5xx or the in-progress 409 keeps it, so a call that landed cannot apply twice
 * (`keyAfterFailure`). Mark billable sends the order's `version` as `expectedVersion`: a stale page
 * is refused with 409 instead of acting on information that has moved.
 *
 * Only async functions are exported: a `'use server'` file turns every export into an endpoint.
 */

/** The state for a form the parser refused: the request never reached the API, so the key is unused. */
function invalid(key: string, errors: FieldErrors): ActionState {
  const { form: broken, ...fields } = errors;
  return broken !== undefined
    ? { key, error: broken, reload: true, errors: fields }
    : { key, errors: fields };
}

/** The words for a refusal, with the key the next try sends. */
function failed(err: unknown, key: string): ActionState {
  const failure = describeBillingFailure(err);
  return {
    key: keyAfterFailure(err, key),
    error: failure.message,
    ...(failure.reload ? { reload: true } : {}),
  };
}

/**
 * The line was taken: someone drafted its invoice after this page loaded, so the page's copy of the
 * line has no `invoiceId`. Read the order again to find it. If that is not possible, ask for a reload.
 */
async function takenBy(
  session: Session,
  salesOrderId: string,
  scheduleLineId: string,
): Promise<{ takenInvoiceId: string } | { reload: true }> {
  try {
    const detail = await getSalesOrder(session, salesOrderId);
    const invoiceId = detail.schedule.find((line) => line.id === scheduleLineId)?.invoiceId;
    if (invoiceId !== null && invoiceId !== undefined && isGuid(invoiceId)) {
      return { takenInvoiceId: invoiceId };
    }
  } catch {
    // Not readable right now: the reload link below is the way forward.
  }
  return { reload: true };
}

/** `POST /v1/sales-orders`: confirm an accepted quotation version, then open the new order. */
export async function confirmOrderAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const session = await requireStaffSession('/sales-orders');
  const key = keyOf(form);

  const parsed = parseConfirm(form);
  if (!parsed.ok) return invalid(key, parsed.errors);

  let orderId: string;
  try {
    orderId = (await confirmSalesOrder(session, parsed.body, key)).order.id;
  } catch (err) {
    return failed(err, key);
  }
  revalidatePath('/sales-orders');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/sales-orders/${encodeURIComponent(orderId)}`);
}

/** `POST /v1/sales-orders/:id/schedule-lines/:lineId/mark-billable`. The dialog reloads the page when closed. */
export async function markBillableAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = keyOf(form);
  const parsed = parseMarkBillable(form);
  if (!parsed.ok) return invalid(key, parsed.errors);

  const { salesOrderId, scheduleLineId, body } = parsed.value;
  const session = await requireStaffSession(`/sales-orders/${salesOrderId}`);
  try {
    await markScheduleLineBillable(session, salesOrderId, scheduleLineId, body, key);
  } catch (err) {
    return failed(err, key);
  }
  return { key, done: true };
}

/** `POST /v1/invoices/from-schedule`: draft an invoice from a billable line, then open the invoice. */
export async function draftInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = keyOf(form);
  const parsed = parseDraft(form);
  if (!parsed.ok) return invalid(key, parsed.errors);

  const { salesOrderId, scheduleLineId } = parsed.value;
  const session = await requireStaffSession(`/sales-orders/${salesOrderId}`);
  let invoiceId: string;
  try {
    invoiceId = (await draftInvoiceFromSchedule(session, { scheduleLineId }, key)).invoice.id;
  } catch (err) {
    const state = failed(err, key);
    return describeBillingFailure(err).kind === 'line_taken'
      ? { ...state, ...(await takenBy(session, salesOrderId, scheduleLineId)) }
      : state;
  }
  revalidatePath(`/sales-orders/${salesOrderId}`);
  redirect(`/invoices/${encodeURIComponent(invoiceId)}`);
}
