'use server';

import { randomUUID } from 'node:crypto';

import { PortalSubmitPaymentBodySchema } from '@bos/contracts';
import { plainAmount } from '@bos/locale';
import { revalidatePath } from 'next/cache';
import { notFound, redirect } from 'next/navigation';

import { todayInKathmandu } from '@/components/portal/quotation-status';
import { ApiError } from '@/lib/api';
import { submitPortalPayment } from '@/lib/api.billing';
import { spaceAware } from '@/lib/amount-hint';
import { getSession } from '@/lib/session';

/**
 * Submit a payment with proof, for the customer. Serves the NFR "no double payments": the form
 * carries an Idempotency-Key the page generated once per render, and the key and the uploaded
 * proof ids stay in the form across a retry, so a double click, or a retry after a timeout, records
 * the payment once. Nothing is computed here: amounts are strings, the customer comes from the
 * signed-in user (the body has no customer id), and the API derives everything else. Error text is
 * ours, never the API's: its detail could name internal ids or rules.
 */

export type PaymentField =
  | 'currency'
  | 'amount'
  | 'method'
  | 'receivedOn'
  | 'bankReference'
  | 'tdsWithheld'
  | 'withholdingCode'
  | 'proof';

export interface PaymentFormState {
  /** The key the next submit will use. Rotated after a definite refusal, kept after an unknown outcome. */
  key: string;
  error?: string;
  fieldErrors?: Partial<Record<PaymentField, string>>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The page's key is a UUID; anything else in the hidden field was tampered with or lost. */
const KEY = /^[A-Za-z0-9-]{8,64}$/;

const FIELD_MESSAGE: Record<PaymentField, string> = {
  currency: 'Choose the currency you paid in.',
  amount:
    'Enter the amount you paid: above zero, with up to 2 decimals (for example 20,18,180.00).',
  method: 'Choose how you paid.',
  receivedOn: 'Enter the date you paid, in the past or today.',
  bankReference: 'The bank reference can be up to 100 characters.',
  tdsWithheld: 'Enter the tax you withheld as an amount, or leave it at 0.00.',
  withholdingCode: 'Name the withholding code when tax was withheld (up to 40 characters).',
  proof: 'Add a bank slip or receipt (a PDF or a picture) as proof of payment.',
};

function text(form: FormData, name: string): string {
  const v = form.get(name);
  return typeof v === 'string' ? v : '';
}

/** Customers type lakh grouping ("20,18,180.00"); the contract wants plain digits. A string clean-up, not arithmetic. */
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
  if (!(err instanceof ApiError)) return '';
  const e = (err.body as { error?: { code?: unknown } } | null | undefined)?.error;
  return typeof e?.code === 'string' ? e.code : '';
}

/** Words for a refused or failed call. Definite refusals rotate the key; unknown outcomes keep it. */
function failed(err: unknown, key: string, returnTo: string): PaymentFormState {
  const status = err instanceof ApiError ? err.status : 0;
  if (status === 401) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (status === 409) {
    // The first attempt may still be running or has landed: the same key replays its result.
    return {
      key,
      error:
        'Your payment is still being recorded. Wait a moment and press Submit again; it will only be recorded once.',
    };
  }
  if (status >= 400 && status < 500) {
    return {
      key: randomUUID(),
      error:
        codeOf(err) === 'validation_failed'
          ? 'We could not record your payment. Check the details and try again.'
          : 'We could not record your payment. Reload the page and try again, or contact us.',
    };
  }
  // A timeout or 5xx: the first call may have landed. The same key makes a retry safe.
  return {
    key,
    error:
      'We could not confirm your payment just now. Please try again; it will only be recorded once.',
  };
}

export async function submitPaymentAction(
  prev: PaymentFormState,
  form: FormData,
): Promise<PaymentFormState> {
  const invoiceHint = text(form, 'invoice');
  const invoiceId = UUID.test(invoiceHint) ? invoiceHint : undefined;
  const returnTo = invoiceId ? `/payments/new?invoice=${invoiceId}` : '/payments/new';

  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (session.orgKind !== 'customer') notFound();

  const submitted = text(form, 'idempotencyKey');
  const key = KEY.test(submitted) ? submitted : prev.key;

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
    currency: text(form, 'currency'),
    amount: normalizeAmount(text(form, 'amount')),
    method: text(form, 'method'),
    receivedOn: text(form, 'receivedOn'),
    tdsWithheld: tds === '' ? '0' : tds,
    proofDocumentIds,
    ...(bankReference === '' ? {} : { bankReference }),
    ...(withholdingCode === '' ? {} : { withholdingCode }),
  };

  const parsed = PortalSubmitPaymentBodySchema.safeParse(candidate);
  const fieldErrors: Partial<Record<PaymentField, string>> = {};
  if (!parsed.success) {
    for (const issue of parsed.error.issues) {
      const head = issue.path[0];
      const field: PaymentField | undefined =
        head === 'proofDocumentIds' ? 'proof' : (head as PaymentField | undefined);
      if (field !== undefined && field in FIELD_MESSAGE) fieldErrors[field] = FIELD_MESSAGE[field];
    }
    // A space inside a typed amount is named, not hidden behind the generic message.
    if (fieldErrors.amount !== undefined) {
      fieldErrors.amount = spaceAware(text(form, 'amount'), fieldErrors.amount);
    }
    if (fieldErrors.tdsWithheld !== undefined) {
      fieldErrors.tdsWithheld = spaceAware(text(form, 'tdsWithheld'), fieldErrors.tdsWithheld);
    }
  }
  // The money date is the customer's own calendar day in Kathmandu; a future date is a typo.
  if (candidate.receivedOn > todayInKathmandu()) fieldErrors.receivedOn = FIELD_MESSAGE.receivedOn;
  if (!parsed.success || fieldErrors.receivedOn !== undefined) {
    // Nothing reached the API, so the same key is still unused.
    return { key, fieldErrors };
  }

  try {
    await submitPortalPayment(session, parsed.data, key);
  } catch (err) {
    return failed(err, key, returnTo);
  }
  revalidatePath('/payments');
  revalidatePath('/invoices');
  if (invoiceId) revalidatePath(`/invoices/${invoiceId}`);
  // `redirect` throws, so it stays outside the try block.
  redirect('/payments?submitted=1');
}
