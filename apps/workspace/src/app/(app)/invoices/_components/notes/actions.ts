'use server';

import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { createCreditNote, createDebitNote } from '@/lib/api-billing';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { failureState, INCOMPLETE, keyOf, refusal, textOf } from '../../new/action-helpers';
import type { InvoiceFormState } from '../../new/form-state';
import { parseCreditNote, parseDebitNote } from '../../new/forms';
import { isGuid, parseCreditLinesJson, parseLinesJson } from '../../new/lines';

/**
 * Credit and debit notes against one issued tax invoice. Serves the NFR "amounts are exact": a credit
 * note names original lines and quantities, a debit note names new lines, and the server prices both
 * and enforces the credit cap. The person lands on the draft note the server answered with.
 *
 * Both need `invoice.credit_note` (Finance; there is no separate debit permission). The key is kept
 * after an unknown outcome and the in-progress 409, and rotated after a final answer.
 * This file exports only async functions: a Server Actions file cannot export values.
 */

const NO_PERMISSION =
  'Your roles do not include credit and debit notes. Ask an administrator if you need to.';

/** A 409 or 422 on a note is the server saying no to this content: usually the credit cap. */
const CAP_WORDS =
  'The platform did not accept this note. A credit note cannot credit more than the invoice, or more than earlier credit notes have left. Lower the quantities, then try again.';
const MOVED_WORDS =
  'The platform did not accept this note, because the invoice or its earlier credit notes changed. Reload the invoice to see where it stands, then try again.';

function noteWords(failure: { kind: string }, which: 'credit' | 'debit'): string | undefined {
  if (which === 'debit') return undefined;
  if (failure.kind === 'invalid') return CAP_WORDS;
  if (failure.kind === 'stale') return MOVED_WORDS;
  return undefined;
}

/** Signs in (back to the invoice afterwards) and takes the page's key. */
async function open(form: FormData) {
  const original = textOf(form, 'originalInvoiceId');
  const session = await requireStaffSession(
    isGuid(original) ? `/invoices/${original}` : '/invoices',
  );
  return { session, key: keyOf(form), original };
}

export async function createCreditNoteAction(
  _prev: InvoiceFormState,
  form: FormData,
): Promise<InvoiceFormState> {
  const { session, key, original } = await open(form);
  if (!(await getPermissionCheck(session))('invoice.credit_note'))
    return refusal(key, NO_PERMISSION);

  const lines = parseCreditLinesJson(textOf(form, 'lines'));
  if (!isGuid(original) || lines === null) return { key, errors: { form: INCOMPLETE } };
  const parsed = parseCreditNote({
    originalInvoiceId: original,
    reason: textOf(form, 'reason'),
    lines,
  });
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createCreditNote(session, parsed.data, key)).invoice.id;
  } catch (err) {
    return failureState(err, key, (f) => noteWords(f, 'credit'));
  }
  revalidatePath('/invoices');
  redirect(`/invoices/${encodeURIComponent(id)}`);
}

export async function createDebitNoteAction(
  _prev: InvoiceFormState,
  form: FormData,
): Promise<InvoiceFormState> {
  const { session, key, original } = await open(form);
  if (!(await getPermissionCheck(session))('invoice.credit_note'))
    return refusal(key, NO_PERMISSION);

  const lines = parseLinesJson(textOf(form, 'lines'));
  if (!isGuid(original) || lines === null) return { key, errors: { form: INCOMPLETE } };
  const parsed = parseDebitNote({
    originalInvoiceId: original,
    reason: textOf(form, 'reason'),
    lines,
  });
  if (!parsed.ok) return { key, errors: parsed.errors };

  let id: string;
  try {
    id = (await createDebitNote(session, parsed.data, key)).invoice.id;
  } catch (err) {
    return failureState(err, key, (f) => noteWords(f, 'debit'));
  }
  revalidatePath('/invoices');
  redirect(`/invoices/${encodeURIComponent(id)}`);
}
