'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { ErrorBodySchema } from '@bos/contracts';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  amendPurchaseOrder,
  cancelAndRecreatePurchaseOrder,
  cancelPurchaseOrder,
  changePurchaseOrderVendor,
  getPurchaseOrder,
  issuePurchaseOrder,
  shortClosePurchaseOrder,
} from '@/lib/api-purchase-orders';
import { ApiError } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';
import { getGrants } from '@/lib/grants';
import type { Session } from '@/lib/session';

import { poFailure, type PoOp } from './_lib/failure';
import { parseAmend, parseReason } from './_lib/forms';
import { poGrants } from './_lib/model';
import type { ActionState } from './_lib/state';

/**
 * Server actions of the purchase order screens: issue, amend, short-close, cancel, change the vendor of a
 * draft, and cancel and recreate an issued order. Each one checks
 * the id, asks `requireStaffSession`, checks `procurement.po.issue` (deny by default; the API still
 * decides every call), validates, and words any refusal for a person.
 *
 * Idempotency: every POST carries the key the form submitted (a key that is not ours is replaced).
 * A definite answer (a 4xx) rotates it, because the next try is a new decision. A timeout, a 5xx or
 * the "still in progress" 409 keeps it, so the first request is replayed instead of repeated.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
const NO_PERMISSION =
  'Your roles do not include changing purchase orders. Ask an administrator if you need to.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

interface Opened {
  id: string;
  session: Session;
  key: string;
}

/** The id, the session, the key and the grant: the same opening for every action. */
async function open(
  prev: ActionState,
  form: FormData,
): Promise<{ ok: true; o: Opened } | { ok: false; state: ActionState }> {
  const id = text(form, 'purchaseOrderId');
  const key = keyOf(form);
  if (!isGuid(id)) return { ok: false, state: { key: prev.key, error: INCOMPLETE, reload: true } };
  const session = await requireStaffSession(`/procurement/orders/${id}`);
  if (!poGrants(await getGrants(session)).issue)
    return { ok: false, state: { key, error: NO_PERMISSION } };
  return { ok: true, o: { id, session, key } };
}

function refused(o: Opened, err: unknown, op: PoOp): ActionState {
  const f = poFailure(err, op);
  return {
    // A definite answer closes this decision; anything else may have landed, so the key stays.
    key: f.definite ? randomUUID() : o.key,
    error: f.message,
    ...(f.reload ? { reload: true } : {}),
  };
}

/** The soft VAT warning of a vendor change (K3 Q2): the dialog shows it and asks for a tick before it goes on. */
const vatWarningOf = (err: unknown): boolean =>
  err instanceof ApiError &&
  err.status === 409 &&
  ErrorBodySchema.safeParse(err.body).data?.error.code === 'VENDOR_NOT_VAT_REGISTERED';
function vatWarned(o: Opened, err: unknown, vendorId: string): ActionState {
  return {
    key: randomUUID(),
    errors: {
      acknowledgeVatWarning: poFailure(err, 'changeVendor').message,
      // The tick belongs to the vendor that raised the warning, never to one chosen afterwards.
      acknowledgeVatWarningVendor: vendorId,
    },
  };
}

function settled(o: Opened, done: string): ActionState {
  revalidatePath('/procurement/orders');
  revalidatePath(`/procurement/orders/${o.id}`);
  return { key: randomUUID(), done };
}

/**
 * Issue sends the `version` the page showed, so the API refuses (`PO_CHANGED`) an order edited since. A form from
 * before the guard sends none and issues as before; anything other than a positive whole number is refused here.
 */
export async function issueAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const seen = text(form, 'expectedVersion');
  if (seen !== '' && !/^[1-9]\d{0,8}$/.test(seen))
    return { key: r.o.key, error: INCOMPLETE, reload: true };
  try {
    if (seen === '') await issuePurchaseOrder(r.o.session, r.o.id, r.o.key);
    else await issuePurchaseOrder(r.o.session, r.o.id, r.o.key, Number(seen));
  } catch (err) {
    return refused(r.o, err, 'issue');
  }
  return settled(
    r.o,
    'The purchase order was issued. Version 1 is final and its PDF can be downloaded.',
  );
}

/**
 * Amend: quantities and prices per line, and optionally the payment terms. Only the changed lines
 * are sent. Whether it needs re-approval is the server's call (a higher total or changed payment
 * terms, F1-Q40), so the answer is worded from the `outcome` the API returns.
 */
export async function amendAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;

  let current;
  try {
    current = await getPurchaseOrder(r.o.session, r.o.id);
  } catch (err) {
    return refused(r.o, err, 'load');
  }
  const lines: Record<string, { quantity: string; unitPrice: string }> = {};
  for (const line of current.lines) {
    lines[line.id] = {
      quantity: text(form, `qty:${line.id}`),
      unitPrice: text(form, `price:${line.id}`),
    };
  }
  const parsed = parseAmend(
    { reason: text(form, 'reason'), paymentTermsDays: text(form, 'paymentTerms'), lines },
    current.lines,
    current.paymentTermsDays,
  );
  if (!parsed.ok) return { key: r.o.key, errors: parsed.errors };

  try {
    const out = await amendPurchaseOrder(r.o.session, r.o.id, parsed.body, r.o.key);
    return settled(
      r.o,
      out.outcome === 'applied'
        ? `The changes were applied. Version ${out.purchaseOrder.currentVersion} was issued.`
        : 'These changes need approval first. The order is marked amendment pending, and stays as it was, until they are approved or rejected.',
    );
  } catch (err) {
    return refused(r.o, err, 'amend');
  }
}

export async function shortCloseAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  try {
    await shortClosePurchaseOrder(r.o.session, r.o.id, reason.data, r.o.key);
  } catch (err) {
    return refused(r.o, err, 'shortClose');
  }
  return settled(
    r.o,
    'The purchase order was short-closed. What has not arrived is no longer expected.',
  );
}

export async function cancelAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  try {
    await cancelPurchaseOrder(r.o.session, r.o.id, reason.data, r.o.key);
  } catch (err) {
    return refused(r.o, err, 'cancel');
  }
  return settled(r.o, 'The purchase order was cancelled.');
}

/** Moves a draft to another vendor (F1-Q40 a). The API checks the vendor and has the last word. */
export async function changeVendorAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const vendorId = text(form, 'vendorId');
  if (!isGuid(vendorId)) return { key: r.o.key, errors: { vendorId: 'Choose a vendor.' } };
  let changed;
  try {
    changed = await changePurchaseOrderVendor(
      r.o.session,
      r.o.id,
      vendorId,
      r.o.key,
      text(form, 'acknowledgeVatWarning') === 'on',
    );
  } catch (err) {
    return vatWarningOf(err) ? vatWarned(r.o, err, vendorId) : refused(r.o, err, 'changeVendor');
  }
  return settled(
    r.o,
    changed.pendingVendorChange
      ? "The new vendor's quotation has a different total, so the change was sent for approval. The order stays as it is, and cannot be issued, until it is decided."
      : "The vendor was changed. The lines, prices and total are the new vendor's quotation, and the payment terms are now the new vendor's.",
  );
}

/**
 * Cancels an issued order and raises a new draft from it in one step, then opens the new draft, where its vendor
 * can be changed before it is issued again.
 */
export async function cancelAndRecreateAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  let draftId: string;
  try {
    draftId = (await cancelAndRecreatePurchaseOrder(r.o.session, r.o.id, reason.data, r.o.key)).id;
  } catch (err) {
    return refused(r.o, err, 'recreate');
  }
  revalidatePath('/procurement/orders');
  revalidatePath(`/procurement/orders/${r.o.id}`);
  revalidatePath(`/procurement/orders/${draftId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect(`/procurement/orders/${encodeURIComponent(draftId)}`);
}
