'use server';

import { randomUUID } from 'node:crypto';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf, nextKey } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  cancelPurchaseRequest,
  createPurchaseRequest,
  submitPurchaseRequest,
  updatePurchaseRequest,
} from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { prFailure, type PrOp } from './_lib/failure';
import { parsePrValues, valuesFromForm } from './_lib/forms';
import type { CommandState, PrFormState } from './_lib/state';

/**
 * Server actions for the purchase request screens. Each one asks `requireStaffSession` first,
 * checks the live permission it needs (deny by default: the API still decides every call), validates
 * with the contracts' schema, and words any refusal for a person through `prFailure`. The browser
 * never sees the API URL or a token.
 *
 * Idempotency: every write carries the key the form submitted. A definite answer (a 4xx other than
 * the "still in progress" 409) rotates it, because the next try is a new decision. A timeout, a
 * 5xx or the in-progress 409 keeps it, so the first request is replayed instead of a second one
 * being made. Money never passes through here except as the text the person typed.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
const NO_CREATE =
  'Your roles do not include raising purchase requests. Ask an administrator if you need to.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/**
 * The `expectedVersion` the person was looking at. Every form sends it, so a missing or bad one
 * means the form is not ours: it is refused rather than sent without the lost-update guard.
 */
function versionOf(form: FormData): number | 'bad' {
  const raw = text(form, 'expectedVersion');
  const n = Number(raw);
  return raw !== '' && Number.isInteger(n) && n >= 1 ? n : 'bad';
}

// ---------------------------------------------------------------------------------------------
// Create and edit
// ---------------------------------------------------------------------------------------------

export async function createPrAction(_prev: PrFormState, form: FormData): Promise<PrFormState> {
  const session = await requireStaffSession('/procurement/requests/new');
  const key = keyOf(form);
  const allowed = await getPermissionCheck(session);
  if (!allowed('procurement.pr.create')) return { key, errors: {}, error: NO_CREATE };
  const parsed = parsePrValues(valuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createPurchaseRequest(session, parsed.data, key)).id;
  } catch (err) {
    return { key: nextKey(err, key), errors: {}, error: prFailure(err, 'create').message };
  }
  revalidatePath('/procurement/requests');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/procurement/requests/${encodeURIComponent(id)}?created=1`);
}

export async function updatePrAction(_prev: PrFormState, form: FormData): Promise<PrFormState> {
  const id = text(form, 'prId');
  const key = keyOf(form);
  const seen = versionOf(form);
  if (!isGuid(id) || seen === 'bad') return { key, errors: {}, error: INCOMPLETE, reload: true };
  const session = await requireStaffSession(`/procurement/requests/${id}/edit`);
  const allowed = await getPermissionCheck(session);
  if (!allowed('procurement.pr.create')) return { key, errors: {}, error: NO_CREATE };
  const parsed = parsePrValues(valuesFromForm(form));
  if (!parsed.ok) return { key, errors: parsed.errors };

  try {
    await updatePurchaseRequest(session, id, parsed.data, key, seen);
  } catch (err) {
    const f = prFailure(err, 'edit');
    return {
      key: nextKey(err, key),
      errors: {},
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/requests');
  revalidatePath(`/procurement/requests/${id}`);
  redirect(`/procurement/requests/${encodeURIComponent(id)}?saved=1`);
}

// ---------------------------------------------------------------------------------------------
// Submit and cancel (the detail page's buttons)
// ---------------------------------------------------------------------------------------------

async function runCommand(
  prev: CommandState,
  form: FormData,
  op: Extract<PrOp, 'submit' | 'cancel'>,
): Promise<CommandState> {
  const id = text(form, 'prId');
  const key = keyOf(form);
  const seen = versionOf(form);
  if (!isGuid(id) || seen === 'bad') {
    return { key, count: prev.count, error: INCOMPLETE, reload: true };
  }
  const session = await requireStaffSession(`/procurement/requests/${id}`);
  const allowed = await getPermissionCheck(session);
  if (!allowed('procurement.pr.create')) return { key, count: prev.count, error: NO_CREATE };

  try {
    if (op === 'submit') await submitPurchaseRequest(session, id, key, seen);
    else await cancelPurchaseRequest(session, id, key, seen);
  } catch (err) {
    const f = prFailure(err, op);
    return {
      key: nextKey(err, key),
      count: prev.count,
      error: f.message,
      ...(f.reload ? { reload: true } : {}),
    };
  }
  revalidatePath('/procurement/requests');
  revalidatePath(`/procurement/requests/${id}`);
  return {
    key: randomUUID(),
    count: prev.count + 1,
    saved:
      op === 'submit'
        ? 'Submitted. The request was sent to the department head for a decision.'
        : 'The request was cancelled.',
  };
}

export async function submitPrAction(prev: CommandState, form: FormData): Promise<CommandState> {
  return runCommand(prev, form, 'submit');
}

export async function cancelPrAction(prev: CommandState, form: FormData): Promise<CommandState> {
  return runCommand(prev, form, 'cancel');
}
