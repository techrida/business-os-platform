import 'server-only';

import {
  type InvoiceDetail,
  PaymentPromiseDtoSchema,
  type PaymentPromiseList,
  PaymentPromiseListSchema,
  type RecordPaymentPromiseBody,
} from '@bos/contracts';
import type { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

import type { Can } from '../_lib/gates';

/**
 * Promises to pay on one invoice (F1-Q33): the list the detail page shows and the command its dialog sends. Server-only:
 * every call carries the user's access token. Bodies are parsed with the contract, so a drifting API fails as 502.
 */

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

async function parse<T>(res: Response, label: string, schema: z.ZodType<T>): Promise<T> {
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success)
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  return parsed.data;
}

const path = (invoiceId: string) =>
  `/v1/receivables/invoices/${encodeURIComponent(invoiceId)}/promises`;

/** `GET /v1/receivables/invoices/:id/promises`: newest first, with what the caller may do. 403 without `ar.read`. */
export async function getInvoicePromises(
  session: Session,
  invoiceId: string,
): Promise<PaymentPromiseList> {
  const res = await apiFetch(session, path(invoiceId));
  return parse(res, 'GET /v1/receivables/invoices/:id/promises', PaymentPromiseListSchema);
}

/** `POST /v1/receivables/invoices/:id/promises`: an open promise on the invoice becomes `replaced`. */
export async function recordInvoicePromise(
  session: Session,
  invoiceId: string,
  body: RecordPaymentPromiseBody,
  key: string,
) {
  const res = await apiFetch(session, path(invoiceId), {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return parse(res, 'POST /v1/receivables/invoices/:id/promises', PaymentPromiseDtoSchema);
}

/**
 * The promises the detail page shows: only an issued tax invoice or debit note can carry one, and only a role that
 * reads receivables is asked. Any failure (403 for a role whose grants were edited, an API that is down) leaves the
 * card out, like the settlement read: the rest of the invoice stands.
 */
export async function invoicePromisesOf(
  session: Session,
  invoice: Pick<InvoiceDetail['invoice'], 'id' | 'kind' | 'status'>,
  can: Can,
): Promise<PaymentPromiseList | null> {
  if (invoice.status !== 'issued') return null;
  if (invoice.kind !== 'tax_invoice' && invoice.kind !== 'debit_note') return null;
  if (!can('ar.read')) return null;
  return getInvoicePromises(session, invoice.id).catch((): null => null);
}
