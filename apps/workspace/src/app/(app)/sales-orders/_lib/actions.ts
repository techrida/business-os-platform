'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { getCreditHold, getOpportunity } from '@/components/p2/crm/crm-api';
import { creditPositionView } from '@/components/p2/crm/credit-position';
import { keyOf } from '@/components/p2/crm/idempotency';
import { apiDetailOf } from '@/lib/api-code';
import { getNumberSystems } from '@/lib/display-settings';
import {
  confirmSalesOrder,
  describeBillingFailure,
  draftInvoiceFromSchedule,
  getSalesOrder,
  keyAfterFailure,
  markScheduleLineBillable,
} from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';

import { codeOf, confirmRefusalText } from './confirm-refusal';
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
 * The deal a `credit_hold` refusal names (F1-Q20), with what the caller may do about it: open the
 * deal (read as them; Finance often cannot, since it reads deals only at `own`) and override the
 * hold (`credit.override`). The refusal carries the deal's id only, never amounts: a `credit.override` holder
 * gets the position read from the credit-hold route, so the Override dialog shows what the hold is made of.
 * The override is for the quotation version the refusal names (`details.quotationVersionId`, R5 FU10), or the
 * submitted one when the refusal names none.
 */
async function creditHoldOf(
  session: Session,
  err: unknown,
  quotationVersionId: string,
): Promise<ActionState['creditHold'] | undefined> {
  if (describeBillingFailure(err).kind !== 'credit_hold') return undefined;
  const id = apiDetailOf(err, 'opportunityId');
  if (typeof id !== 'string' || !isGuid(id)) return undefined;
  const refused = apiDetailOf(err, 'quotationVersionId');
  const versionId = typeof refused === 'string' && isGuid(refused) ? refused : quotationVersionId;
  const [deal, canOverride] = await Promise.all([
    getOpportunity(session, id).catch(() => null),
    getPermissionCheck(session).then(
      (can) => can('credit.override'),
      () => false,
    ),
  ]);
  const position = canOverride
    ? await getCreditHold(session, id)
        .then(async (hold) => creditPositionView(hold, await getNumberSystems()))
        .catch(() => null)
    : null;
  return {
    opportunityId: id,
    number: deal?.number ?? null,
    canOpen: deal !== null,
    canOverride,
    quotationVersionId: versionId,
    ...(position ? { position } : {}),
  };
}

/**
 * The invoice the line holds now, read from the order again, and only when the line says the caller may
 * open it (`can.openInvoice`, invoice.read on that invoice): drafting needs invoice.draft, which does not
 * include reading the invoice. Undefined when the order cannot be read, the line holds none, or the
 * caller may not open it.
 */
async function openableInvoiceOf(
  session: Session,
  salesOrderId: string,
  scheduleLineId: string,
): Promise<string | undefined> {
  try {
    const detail = await getSalesOrder(session, salesOrderId);
    const line = detail.schedule.find((l) => l.id === scheduleLineId);
    const invoiceId = line?.invoiceId;
    if (
      line?.can?.openInvoice === true &&
      invoiceId !== null &&
      invoiceId !== undefined &&
      isGuid(invoiceId)
    ) {
      return invoiceId;
    }
  } catch {
    // Not readable right now: the caller goes back to the order instead.
  }
  return undefined;
}

/**
 * The line was taken: someone drafted its invoice after this page loaded, so the page's copy of the
 * line has no `invoiceId`. Read the order again to find it, and link it only when the caller may open
 * it. Otherwise ask for a reload, which shows the line with its invoice.
 */
async function takenBy(
  session: Session,
  salesOrderId: string,
  scheduleLineId: string,
): Promise<{ takenInvoiceId: string } | { reload: true }> {
  const invoiceId = await openableInvoiceOf(session, salesOrderId, scheduleLineId);
  return invoiceId !== undefined ? { takenInvoiceId: invoiceId } : { reload: true };
}

/** `POST /v1/sales-orders`: confirm an accepted quotation version, then open the new order. */
export async function confirmOrderAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await confirmOrder(prev, form);
  if (!('orderId' in result)) return result;
  revalidatePath('/sales-orders');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/sales-orders/${encodeURIComponent(result.orderId)}`);
}

/**
 * The same call from the draft's own page: the order is already open there, so it answers `done` instead of
 * redirecting to the page it is on. The dialog then refreshes the page and puts focus on its heading (a redirect
 * to the same address left focus on `<body>`).
 */
export async function confirmDraftAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const result = await confirmOrder(prev, form);
  if (!('orderId' in result)) return result;
  revalidatePath('/sales-orders');
  revalidatePath(`/sales-orders/${result.orderId}`);
  return { key: keyOf(form), done: true };
}

async function confirmOrder(
  _prev: ActionState,
  form: FormData,
): Promise<ActionState | { orderId: string }> {
  const session = await requireStaffSession('/sales-orders');
  const key = keyOf(form);

  const parsed = parseConfirm(form);
  if (!parsed.ok) return invalid(key, parsed.errors);

  let orderId: string;
  try {
    orderId = (await confirmSalesOrder(session, parsed.body, key)).order.id;
  } catch (err) {
    const own = confirmRefusalText(err);
    if (own !== undefined) {
      // The order was confirmed meanwhile (evidence_not_filed): the page shows a stale draft, so offer a reload.
      const notFiled = codeOf(err) === 'evidence_not_filed';
      return { key: keyAfterFailure(err, key), error: own, ...(notFiled ? { reload: true } : {}) };
    }
    const creditHold = await creditHoldOf(session, err, parsed.body.quotationVersionId);
    return { ...failed(err, key), ...(creditHold ? { creditHold } : {}) };
  }
  return { orderId };
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

/**
 * `POST /v1/invoices/from-schedule`: draft an invoice from a billable line, then open the invoice when the
 * line says the caller may (`can.openInvoice`). Someone who may draft but not read invoices goes back to
 * the order, which says the draft was created.
 */
export async function draftInvoiceAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = keyOf(form);
  const parsed = parseDraft(form);
  if (!parsed.ok) return invalid(key, parsed.errors);

  const { salesOrderId, scheduleLineId } = parsed.value;
  const session = await requireStaffSession(`/sales-orders/${salesOrderId}`);
  try {
    await draftInvoiceFromSchedule(session, { scheduleLineId }, key);
  } catch (err) {
    const state = failed(err, key);
    return describeBillingFailure(err).kind === 'line_taken'
      ? { ...state, ...(await takenBy(session, salesOrderId, scheduleLineId)) }
      : state;
  }
  revalidatePath(`/sales-orders/${salesOrderId}`);
  const invoiceId = await openableInvoiceOf(session, salesOrderId, scheduleLineId);
  // `redirect` throws, so it stays outside the try blocks.
  redirect(
    invoiceId !== undefined
      ? `/invoices/${encodeURIComponent(invoiceId)}`
      : `/sales-orders/${encodeURIComponent(salesOrderId)}?drafted=1`,
  );
}
