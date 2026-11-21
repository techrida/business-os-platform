'use server';

import { randomUUID } from 'node:crypto';

import {
  CreateVendorBillBodySchema,
  ErrorBodySchema,
  RequestMatchExceptionBodySchema,
} from '@bos/contracts';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { keyOf } from '@/components/p2/crm/idempotency';
import { isGuid } from '@/components/p2/customers/format';
import {
  convertBillSubmission,
  createBill,
  discardBill,
  matchBill,
  rejectBillSubmission,
  requestBillException,
  submitBill,
  voidBill,
  type VendorBill,
} from '@/lib/api-payables';
import { ApiError } from '@/lib/api';
import { requireStaffSession } from '@/lib/bff';
import { getGrants, hasGrant } from '@/lib/grants';
import type { Session } from '@/lib/session';

import { parseReason } from '../procurement/orders/_lib/forms';
import type { ActionState } from '../procurement/orders/_lib/state';
import { billFailure, type BillOp } from './_lib/failure';
import {
  EMPTY_ROW,
  ACTIVE_ACCOUNT_IDS_FIELD,
  EXPENSE_ACCOUNT_INVALID,
  MAX_LINES,
  expenseAccountErrors,
  parseActiveAccountIds,
  parseBillLines,
  type LineRow,
} from './_lib/forms';
import { MATCH_STATUS_LABEL } from './_lib/model';

/**
 * Server actions of the payables screens: match, submit and void a bill, convert an inbox
 * submission into a bill, and reject one. Each one checks the id, asks `requireStaffSession`,
 * checks the person's grant (`payables.bill.enter`) before any write, validates, and words any
 * refusal. Totals are never computed here: what the API returns is what is shown.
 *
 * Idempotency: every POST carries the key the form submitted (a key that is not ours is replaced).
 * A definite answer (a 4xx) rotates it; a timeout, a 5xx or the "still in progress" 409 keeps it,
 * so the first request is replayed instead of repeated. A form the checks refuse never reached the
 * API, so it keeps its key too.
 */

const INCOMPLETE = 'This form is incomplete. Reload the page and try again.';
const NO_ENTER =
  'Your roles do not allow this. Bills are keyed in, matched and voided by the accountants. Ask an administrator if you need that role.';

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

function refused(key: string, err: unknown, op: BillOp): ActionState {
  const f = billFailure(err, op);
  return {
    // A definite answer closes this decision; anything else may have landed, so the key stays.
    key: f.definite ? randomUUID() : key,
    error: f.message,
    ...(f.reload ? { reload: true } : {}),
  };
}

/**
 * A refusal of the lines' expense accounts (422 `EXPENSE_ACCOUNT_INVALID`) as field errors on the account
 * pickers of the lines whose account is not among the active ones the page loaded, with a fresh key (the answer
 * is definite); undefined for any other failure.
 */
function accountRefusal(
  err: unknown,
  rows: readonly LineRow[],
  form: FormData,
): ActionState | undefined {
  if (!(err instanceof ApiError) || err.status !== 422) return undefined;
  const parsed = ErrorBodySchema.safeParse(err.body);
  if (!parsed.success || parsed.data.error.code !== EXPENSE_ACCOUNT_INVALID) return undefined;
  const errors = expenseAccountErrors(
    rows,
    parseActiveAccountIds(form.get(ACTIVE_ACCOUNT_IDS_FIELD)),
  );
  return Object.keys(errors).length > 0 ? { key: randomUUID(), errors } : undefined;
}

interface Opened {
  id: string;
  session: Session;
  key: string;
}

/**
 * Whether the person may key in bills, by the live grants (GET /v1/me) the new-bill page is gated on, so
 * the page and its writes agree for a role an admin edited.
 */
async function mayEnterBills(session: Session): Promise<boolean> {
  return hasGrant(await getGrants(session), 'payables.bill.enter');
}

/**
 * The id, the session and the key for a bill or submission action; refuses a person without the live
 * `payables.bill.enter` grant, the same one the bill screens are gated on.
 */
async function open(
  prev: ActionState,
  form: FormData,
  field: 'billId' | 'submissionId',
  back: (id: string) => string,
): Promise<{ ok: true; o: Opened } | { ok: false; state: ActionState }> {
  const id = text(form, field);
  const key = keyOf(form);
  if (!isGuid(id)) return { ok: false, state: { key: prev.key, error: INCOMPLETE, reload: true } };
  const session = await requireStaffSession(back(id));
  if (!(await mayEnterBills(session))) return { ok: false, state: { key, error: NO_ENTER } };
  return { ok: true, o: { id, session, key } };
}

const billPath = (id: string) => `/payables/bills/${id}`;

function settledBill(id: string, done: string): ActionState {
  revalidatePath('/payables/bills');
  revalidatePath(billPath(id));
  return { key: randomUUID(), done };
}

// ------------------------------------------------------------------------------------------ bills

export async function matchBillAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form, 'billId', billPath);
  if (!r.ok) return r.state;
  try {
    const bill = await matchBill(r.o.session, r.o.id, r.o.key);
    return settledBill(
      r.o.id,
      `The bill was matched against its purchase order and receipts again. Result: ${MATCH_STATUS_LABEL[bill.matchStatus].text.toLowerCase()}.`,
    );
  } catch (err) {
    return refused(r.o.key, err, 'match');
  }
}

export async function submitBillAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form, 'billId', billPath);
  if (!r.ok) return r.state;
  try {
    await submitBill(r.o.session, r.o.id, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'submit');
  }
  return settledBill(
    r.o.id,
    'The bill was sent for approval. It is approved in the approvals inbox, by someone other than the person who keyed it in.',
  );
}

export async function voidBillAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form, 'billId', billPath);
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  try {
    await voidBill(r.o.session, r.o.id, reason.data, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'void');
  }
  return settledBill(
    r.o.id,
    'The bill was voided. A vendor debit note now cancels it in the payables ledger, and the reason is on the audit trail.',
  );
}

export async function discardBillAction(prev: ActionState, form: FormData): Promise<ActionState> {
  const r = await open(prev, form, 'billId', billPath);
  if (!r.ok) return r.state;
  try {
    await discardBill(r.o.session, r.o.id, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'discard');
  }
  return settledBill(r.o.id, 'The draft bill was discarded. Its invoice number can be used again.');
}

export async function requestExceptionAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form, 'billId', billPath);
  if (!r.ok) return r.state;
  const evidence = text(form, 'evidenceDocumentId').trim();
  const parsed = RequestMatchExceptionBodySchema.safeParse({
    reason: text(form, 'reason'),
    ...(evidence === '' ? {} : { evidenceDocumentId: evidence }),
  });
  if (!parsed.success) {
    const errors: Record<string, string> = {};
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'reason');
      errors[field] =
        field === 'reason'
          ? 'Give a reason of 1 to 1,000 characters.'
          : 'That file could not be used. Upload it again, or remove it.';
    }
    return { key: r.o.key, errors };
  }
  try {
    await requestBillException(r.o.session, r.o.id, parsed.data, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'exception');
  }
  return settledBill(
    r.o.id,
    'The match exception was sent to Finance. Finance decides it in the approvals inbox.',
  );
}

// ------------------------------------------------------------------------------------ submissions

/** The rows the entry form posts: `lineCount`, then `line:<i>:<field>` for each. */
function rowsOf(form: FormData): LineRow[] | null {
  const count = Number(text(form, 'lineCount'));
  if (!Number.isInteger(count) || count < 0 || count > MAX_LINES + 50) return null;
  const rows: LineRow[] = [];
  for (let i = 0; i < count; i += 1) {
    const field = (name: keyof LineRow): string => text(form, `line:${i}:${name}`);
    rows.push({
      ...EMPTY_ROW,
      poLineId: field('poLineId'),
      receiptLineId: field('receiptLineId'),
      accountId: field('accountId'),
      quantity: field('quantity'),
      unitPrice: field('unitPrice'),
      taxCodeId: field('taxCodeId'),
      tdsCodeId: field('tdsCodeId'),
    });
  }
  return rows;
}

export async function convertSubmissionAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form, 'submissionId', (id) => `/payables/bills/new?submission=${id}`);
  if (!r.ok) return r.state;
  const rows = rowsOf(form);
  if (rows === null) return { key: r.o.key, error: INCOMPLETE, reload: true };
  const parsed = parseBillLines(rows);
  if (!parsed.ok) return { key: r.o.key, errors: parsed.errors };

  let bill: VendorBill;
  try {
    bill = await convertBillSubmission(r.o.session, r.o.id, parsed.lines, r.o.key);
  } catch (err) {
    return accountRefusal(err, rows, form) ?? refused(r.o.key, err, 'convert');
  }
  revalidatePath('/payables/inbox');
  revalidatePath('/payables/bills');
  // `redirect` throws, so it stays outside the try block.
  redirect(`${billPath(encodeURIComponent(bill.id))}?created=1`);
}

export async function createBillAction(_prev: ActionState, form: FormData): Promise<ActionState> {
  const key = keyOf(form);
  const session = await requireStaffSession('/payables/bills/new');
  if (!(await mayEnterBills(session))) return { key, error: NO_ENTER };
  const rows = rowsOf(form);
  if (rows === null) return { key, error: INCOMPLETE, reload: true };
  const lines = parseBillLines(rows);
  const purchaseOrderId = text(form, 'purchaseOrderId').trim();
  const parsed = CreateVendorBillBodySchema.safeParse({
    vendorPartyId: text(form, 'vendorPartyId').trim(),
    vendorInvoiceNo: text(form, 'vendorInvoiceNo'),
    invoiceDate: text(form, 'invoiceDate').trim(),
    documentId: text(form, 'documentId').trim(),
    kind: 'bill',
    currency: 'NPR',
    ...(purchaseOrderId === '' ? {} : { purchaseOrderId }),
    lines: lines.ok ? lines.lines : [],
  });
  const errors: Record<string, string> = lines.ok ? {} : { ...lines.errors };
  if (!parsed.success)
    for (const issue of parsed.error.issues) {
      const field = String(issue.path[0] ?? 'lines');
      if (field === 'lines' && !lines.ok) continue;
      errors[field] =
        field === 'documentId'
          ? 'Upload the invoice file before creating the bill.'
          : field === 'invoiceDate'
            ? 'Choose a valid invoice date.'
            : field === 'vendorInvoiceNo'
              ? 'Enter an invoice number of 1 to 64 characters.'
              : field === 'vendorPartyId'
                ? 'Choose a vendor.'
                : 'Check this field and try again.';
    }
  if (!parsed.success || Object.keys(errors).length > 0) return { key, errors };
  let bill: VendorBill;
  try {
    bill = await createBill(session, parsed.data, key);
  } catch (err) {
    return accountRefusal(err, rows, form) ?? refused(key, err, 'create');
  }
  revalidatePath('/payables/bills');
  redirect(`${billPath(encodeURIComponent(bill.id))}?created=1`);
}

export async function rejectSubmissionAction(
  prev: ActionState,
  form: FormData,
): Promise<ActionState> {
  const r = await open(prev, form, 'submissionId', () => '/payables/inbox');
  if (!r.ok) return r.state;
  const reason = parseReason(text(form, 'reason'));
  if (!reason.ok) return { key: r.o.key, errors: { reason: reason.error } };
  try {
    await rejectBillSubmission(r.o.session, r.o.id, reason.data, r.o.key);
  } catch (err) {
    return refused(r.o.key, err, 'reject');
  }
  revalidatePath('/payables/inbox');
  return {
    key: randomUUID(),
    done: 'The submission was rejected. The reason is kept with it.',
  };
}
