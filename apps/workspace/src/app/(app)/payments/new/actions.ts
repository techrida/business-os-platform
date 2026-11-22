'use server';

import { randomUUID } from 'node:crypto';

import { SubmitPaymentBodySchema } from '@bos/contracts';
import { NO_SPACES, USE_A_POINT, hasInnerSpace, hasStrayComma, plainAmount } from '@bos/locale';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { getInvoice } from '@/lib/api-billing';
import { findPaymentReferenceMatches } from '@/lib/api-payments';
import { submitPayment } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { getPermissionCheck } from '@/lib/live-permissions';

import { describePaymentFailure } from '../_lib/failure';

import {
  INVALID_PROOF_MESSAGE,
  NO_RECORD_WORDS,
  NOT_FOUND_MESSAGE,
  type RecordPaymentField,
  type RecordPaymentState,
  STALE_MESSAGE,
  UNKNOWN_CODE_MESSAGE,
} from './form-state';

/**
 * Record a payment on a customer's behalf, with proof. Serves the NFR "no double payments": the
 * form carries an Idempotency-Key the page generated once per render, and the key and the uploaded
 * proof ids stay in the form across a retry. Nothing here computes money: amounts are strings, the
 * contract's own schema checks their shape, and the API derives everything else.
 *
 * Key rule (same as the review and allocate actions): a definite answer (any 4xx other than the
 * in-progress 409) ends this click, so the next try is a new decision with a new key. A timeout, a
 * 5xx or the 409 "first request still running" may have landed, so the same key goes again and the
 * API replays the first result instead of recording a second payment. A form refused here never
 * reached the API, so its key is unused and is kept. Error text is ours; the one exception is a 400,
 * where the platform names the field it did not accept.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

const BROKEN = 'This form is incomplete. Reload the page and try again.';
const INVOICE_UNREADABLE =
  'The invoice this payment is for could not be read. Reload the page and try again.';

const FIELD_MESSAGE: Record<RecordPaymentField, string> = {
  customerId: 'Choose the customer who paid.',
  currency: 'Choose the currency the customer paid in.',
  amount:
    'Enter the amount received: above zero, with up to 2 decimals (for example 20,18,180.00).',
  method: 'Choose how the customer paid.',
  receivedOn: 'Enter the date the money was received, in the past or today.',
  bankReference: 'The bank reference can be up to 100 characters.',
  tdsWithheld: 'Enter the tax withheld as an amount with up to 2 decimals, or leave it at 0.00.',
  withholdingCode: 'Name the withholding code when tax was withheld (up to 40 characters).',
  proof: 'Add a bank slip or receipt (a PDF or a picture) as proof of payment.',
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** Lakh grouping ("20,18,180.00") is typed naturally; the contract wants plain digits. A string clean-up, not arithmetic. */
function normalizeAmount(raw: string): string {
  return canonicalAmount(plainAmount(raw));
}

/**
 * The amount as the number inputs post it once hydrated (`1250.00` is `1250`). A form posted before
 * hydration carries the padded text, and a retry under the same idempotency key must not change body.
 */
function canonicalAmount(plain: string): string {
  return /^\d+\.\d*$/.test(plain) ? plain.replace(/\.?0*$/, '') || '0' : plain;
}

function codeOf(err: unknown): string {
  const body = typeof err === 'object' && err !== null && 'body' in err ? err.body : undefined;
  const e = (body as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof e?.code === 'string' ? e.code : '';
}

/** The state after the API refused or did not answer; see the key rule above. */
function refused(err: unknown, key: string): RecordPaymentState {
  const failure = describePaymentFailure(err);
  const next = failure.definite ? randomUUID() : key;
  if (failure.status === 422 && codeOf(err) === 'invalid_proof') {
    return { key: next, error: INVALID_PROOF_MESSAGE };
  }
  if (failure.status === 422 && codeOf(err) === 'unknown_withholding_code') {
    return { key: next, fieldErrors: { withholdingCode: UNKNOWN_CODE_MESSAGE } };
  }
  if (failure.status === 422 && codeOf(err) === 'unknown_customer') {
    return { key: next, error: NOT_FOUND_MESSAGE };
  }
  if (failure.kind === 'not_found') return { key: next, error: NOT_FOUND_MESSAGE };
  if (failure.kind === 'stale') return { key: next, error: STALE_MESSAGE, reload: true };
  return { key: next, error: failure.message };
}

export async function recordPaymentAction(
  prev: RecordPaymentState,
  form: FormData,
): Promise<RecordPaymentState> {
  const session = await requireStaffSession('/payments/new');
  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : prev.key;
  if (!KEY.test(key)) return { key: randomUUID(), error: BROKEN, reload: true };
  if (!(await getPermissionCheck(session))('payment.record')) {
    return { key, error: NO_RECORD_WORDS };
  }

  // A form opened from an invoice pays that invoice's customer (item 3b): read the invoice again as this person and
  // take its customer, whatever the posted customer field says. Needs invoice.read, never customer.read. Nothing has
  // reached the API if the read fails, so the key is kept.
  const invoiceId = text(form, 'invoiceId');
  let customerId = text(form, 'customerId');
  if (UUID.test(invoiceId)) {
    try {
      customerId = (await getInvoice(session, invoiceId)).invoice.customerId;
    } catch {
      return { key, error: INVOICE_UNREADABLE, reload: true };
    }
  }

  const proofDocumentIds = [
    ...new Set(
      form
        .getAll('proofDocumentId')
        .filter((v): v is string => typeof v === 'string' && UUID.test(v)),
    ),
  ];
  const bankReference = text(form, 'bankReference').trim();
  const withholdingCode = text(form, 'withholdingCode').trim();
  const tds = normalizeAmount(text(form, 'tdsWithheld'));
  const candidate = {
    customerId,
    currency: text(form, 'currency'),
    amount: normalizeAmount(text(form, 'amount')),
    method: text(form, 'method'),
    receivedOn: text(form, 'receivedOn'),
    tdsWithheld: tds === '' ? '0' : tds,
    proofDocumentIds,
    ...(bankReference === '' ? {} : { bankReference }),
    ...(withholdingCode === '' ? {} : { withholdingCode }),
  };

  const parsed = SubmitPaymentBodySchema.safeParse(candidate);
  const fieldErrors: Partial<Record<RecordPaymentField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field: RecordPaymentField | undefined =
        head === 'proofDocumentIds' ? 'proof' : (head as RecordPaymentField | undefined);
      if (field !== undefined && field in FIELD_MESSAGE) fieldErrors[field] = FIELD_MESSAGE[field];
    }
  }
  // "10 50" is refused rather than read as 1050; the digits look fine to the person, so name the space.
  // A comma that is not grouping ("10,50") is a decimal comma: say so, for the same reason.
  for (const field of ['amount', 'tdsWithheld'] as const) {
    if (fieldErrors[field] === undefined) continue;
    if (hasInnerSpace(text(form, field))) fieldErrors[field] = NO_SPACES;
    else if (hasStrayComma(text(form, field))) {
      fieldErrors[field] = `${USE_A_POINT} ${fieldErrors[field]}`;
    }
  }
  // Tax withheld needs its code. The contract says so too, but its object-level check may not run
  // when another field already failed, so the person is told about every wrong field at once.
  // `[1-9]` is "some non-zero digit": a shape test on the text, not arithmetic.
  if (/[1-9]/.test(candidate.tdsWithheld) && withholdingCode === '') {
    fieldErrors.withholdingCode = FIELD_MESSAGE.withholdingCode;
  }
  // The money date is the Kathmandu calendar day; a future date is a typo.
  if (candidate.receivedOn > todayInKathmandu()) fieldErrors.receivedOn = FIELD_MESSAGE.receivedOn;
  if (!parsed.success || Object.keys(fieldErrors).length > 0) {
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  // A bank reference already on file is a warning, never a refusal (TR-Q12d): the person sees the
  // earlier payments and confirms. The confirm box names the payments it was shown, so a payment
  // recorded since then warns again. If the check cannot be read, the payment is recorded anyway.
  if (parsed.data.bankReference !== undefined) {
    const confirmed = new Set(
      text(form, 'referenceConfirmed')
        .split(',')
        .filter((id) => UUID.test(id)),
    );
    const matches = await findPaymentReferenceMatches(session, parsed.data.bankReference).catch(
      () => [],
    );
    if (matches.some((m) => !confirmed.has(m.id))) {
      // Nothing reached the record route, so the same key is still unused.
      return { key, referenceMatches: matches };
    }
  }

  let paymentId: string;
  try {
    paymentId = (await submitPayment(session, parsed.data, key)).id;
  } catch (err) {
    if (describePaymentFailure(err).kind === 'session') {
      redirect(`/auth/login?returnTo=${encodeURIComponent('/payments/new')}`);
    }
    return refused(err, key);
  }
  revalidatePath('/payments');
  // `redirect` throws, so it stays outside the try block.
  redirect(`/payments/${encodeURIComponent(paymentId)}`);
}
