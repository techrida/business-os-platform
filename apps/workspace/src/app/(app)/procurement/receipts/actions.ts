'use server';

import { randomUUID } from 'node:crypto';

import { ReceiptKindSchema } from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  confirmReceipt,
  discardReceipt,
  createReceipt,
  getPoProgress,
  getReceipt,
  reverseReceipt,
  type Receipt,
} from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import type { Session } from '@/lib/session';

import { parseReason } from '../orders/_lib/forms';
import type { ActionState } from '../orders/_lib/state';
import { noPermission, receiptFailure, type ReceiptOp } from './_lib/failure';
import { parseReceipt, type LineValues, type ReceiptValues } from './_lib/forms';
import { mayHandleKind, receiptGrants } from './_lib/model';

/**
 * Server actions of the receipt screens: create a draft, confirm it, reverse it. Each one checks
 * the id, asks `requireStaffSession`, checks the kind against the person's grant (goods need
 * `procurement.receipt.confirm`; a service is offered to everyone because its requester may also
 * confirm it, and the API's 403 is worded for that), validates, and words any refusal.
 *
 * Idempotency: every POST carries the key the form submitted (a key that is not ours is replaced).
 * A definite answer (a 4xx) rotates it; a timeout, a 5xx or the "still in progress" 409 keeps it,
 * so the first request is replayed instead of repeated. A form the checks refuse never reached
 * the API, so it keeps its key too.
 *
 * The create action reads the order's progress again instead of trusting the form for what is
 * open. After a create whose answer was lost, that read already counts the draft, so a retry can
 * be refused here by the quantity check; the draft is then in the order's receipts list.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function refused(key: string, err: unknown, op: ReceiptOp, kind?: Receipt['kind']): ActionState {
  const f = receiptFailure(err, op, kind);
  return {
    // A definite answer closes this decision; anything else may have landed, so the key stays.
    key: f.definite ? randomUUID() : key,
    error: f.message,
    ...(f.reload ? { reload: true } : {}),
  };
}

// ------------------------------------------------------------------------------------------ create

export async function createReceiptAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const poId = text(form, 'purchaseOrderId');
  const key = keyOf(form);
  if (!isGuid(poId)) return { key: prev.key, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/procurement/receipts/new?po=${poId}`);

  const kind = ReceiptKindSchema.safeParse(text(form, 'kind'));
  if (!kind.success) return { key, errors: { kind: 'Choose whether this is goods or a service.' } };
  if (!mayHandleKind(kind.data, receiptGrants(session.roles))) {
    return { key, error: noPermission(kind.data) };
  }

  let progress;
  try {
    progress = await getPoProgress(session, poId);
  } catch (err) {
    return refused(key, err, 'load', kind.data);
  }

  const lines: Record<string, LineValues> = {};
  for (const line of progress.lines) {
    lines[line.poLineId] = {
      quantity: text(form, `qty:${line.poLineId}`),
      serials: text(form, `serials:${line.poLineId}`),
      inspection: text(form, `inspection:${line.poLineId}`),
      note: text(form, `note:${line.poLineId}`),
    };
  }
  const values: ReceiptValues = {
    kind: kind.data,
    receivedAt: text(form, 'receivedAt'),
    location: text(form, 'location'),
    lines,
  };
  const parsed = parseReceipt(poId, values, progress.lines);
  if (!parsed.ok) return { key, errors: parsed.errors };

  let created: Receipt;
  try {
    created = await createReceipt(session, parsed.body, key);
  } catch (err) {
    return refused(key, err, 'create', kind.data);
  }
  revalidatePath('/procurement/receipts');
  revalidatePath(`/procurement/orders/${poId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect(`/procurement/receipts/${encodeURIComponent(created.id)}?created=1`);
}

// ------------------------------------------------------------------------ confirm and reverse

interface Opened {
  id: string;
  session: Session;
  key: string;
  receipt: Receipt;
}

/**
 * The id, the session, the key and the receipt's kind: the same opening for both actions. The
 * receipt is read only for its kind (to refuse a goods receipt without the grant before any
 * write). Its status is not checked here: after a lost answer the replay of the same key must
 * still reach the API, which returns the first result.
 */
async function open(
  prev: ActionState,
  form: FormData,
): Promise<{ ok: true; o: Opened } | { ok: false; state: ActionState }> {
  const id = text(form, 'receiptId');
  const key = keyOf(form);
  if (!isGuid(id)) return { ok: false, state: { key: prev.key, error: INCOMPLETE, reload: true } };
  const session = await requireStaffSession(`/procurement/receipts/${id}`);
  let receipt: Receipt;
  try {
    receipt = await getReceipt(session, id);
  } catch (err) {
    return { ok: false, state: refused(key, err, 'load') };
  }
  if (!mayHandleKind(receipt.kind, receiptGrants(session.roles))) {
    return { ok: false, state: { key, error: noPermission(receipt.kind) } };
  }
  return { ok: true, o: { id, session, key, receipt } };
}

function settled(o: Opened, done: string): ActionState {
  revalidatePath('/procurement/receipts');
  revalidatePath(`/procurement/receipts/${o.id}`);
  revalidatePath(`/procurement/orders/${o.receipt.purchaseOrderId}`);
  return { key: randomUUID(), done };
}

export async function confirmReceiptAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  try {
    await confirmReceipt(r.o.session, r.o.id, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'confirm', r.o.receipt.kind);
  }
  return settled(
    r.o,
    'The receipt was confirmed. The purchase order now counts what arrived, and the quantities are final.',
  );
}

export async function discardReceiptAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  try {
    await discardReceipt(r.o.session, r.o.id, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'discard', r.o.receipt.kind);
  }
  return settled(r.o, 'The draft receipt was discarded. Its reserved quantities are open again.');
}

export async function reverseReceiptAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form);
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  try {
    const out = await reverseReceipt(r.o.session, r.o.id, reason.data, r.o.key);
    return settled(
      r.o,
      `The receipt was reversed. ${out.number} records the reversal, and the quantities it took are open again.`,
    );
  } catch (err) {
    return refused(r.o.key, err, 'reverse', r.o.receipt.kind);
  }
}
