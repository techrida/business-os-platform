import 'server-only';

import {
  CurrencySchema,
  type CustomerInvoiceView,
  CustomerInvoiceViewSchema,
  DecimalString,
  InvoiceSettlementSchema,
  PaymentMethodSchema,
  PaymentStatusSchema,
  type PortalInvoiceListItem,
  PortalInvoiceListItemSchema,
  type PortalSalesOrder,
  PortalSalesOrderSchema,
  type PortalSubmitPaymentBody,
  PortalSubmitPaymentBodySchema,
  type SignedLinkDto,
  SignedLinkDtoSchema,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Customer billing calls from the portal BFF (PT3): issued invoices, their settlement, the
 * customer's own payments, and payment submit with proof. Same shape as the quotation calls in
 * api.ts: every answer is parsed with a strict schema, so an internal field fails the parse (502)
 * instead of reaching a page, and a draft or someone else's invoice is answered 404 by the API.
 *
 * The U13 portal billing API is not built when this is written. The paths below are assumptions
 * that follow `/v1/portal/quotations`:
 *
 *   GET  /v1/portal/invoices                       -> PortalInvoiceListItem[]
 *   GET  /v1/portal/invoices/:id                   -> CustomerInvoiceView
 *   GET  /v1/portal/invoices/:id/settlement        -> InvoiceSettlement (derived from allocations)
 *   GET  /v1/portal/invoices/:id/document          -> SignedLinkDto (opened through openSignedFile)
 *   GET  /v1/portal/payments                       -> PortalPaymentListItem[]
 *   POST /v1/portal/payment-proofs                 -> { documentId, versionId, uploadPath }
 *   PUT  <uploadPath> (raw file bytes)             -> 2xx
 *   POST /v1/portal/payments (Idempotency-Key)     -> 2xx
 *   GET  /v1/portal/sales-orders                   -> PortalSalesOrder[] (milestones, F1-Q34)
 *   GET  /v1/portal/sales-orders/:id               -> PortalSalesOrder
 */

const seg = (id: string): string => encodeURIComponent(id);

async function readBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text === '') return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

/** Calls the API and parses the answer with `schema`. A refusal throws `ApiError` with its status; a body off the contract throws 502. */
async function call<T>(
  session: Pick<Session, 'accessToken'>,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = { method: 'GET' },
): Promise<T> {
  const res = await apiFetch(session as Session, path, init);
  const body = await readBody(res);
  const label = `${init.method ?? 'GET'} ${path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/**
 * `GET /v1/portal/sales-orders`: the customer's confirmed and completed orders with their milestones (the billing
 * schedule, F1-Q34). The strict schema refuses any staff field.
 */
export function listPortalSalesOrders(
  session: Pick<Session, 'accessToken'>,
): Promise<PortalSalesOrder[]> {
  return call(session, '/v1/portal/sales-orders', z.array(PortalSalesOrderSchema));
}

/** `GET /v1/portal/sales-orders/:id`. The API answers 404 for another customer's, a draft, cancelled or unknown order. */
export function getPortalSalesOrder(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<PortalSalesOrder> {
  return call(session, `/v1/portal/sales-orders/${seg(id)}`, PortalSalesOrderSchema);
}

/** `GET /v1/portal/invoices`: the customer's issued invoices and notes only. */
export function listPortalInvoices(
  session: Pick<Session, 'accessToken'>,
): Promise<PortalInvoiceListItem[]> {
  return call(session, '/v1/portal/invoices', z.array(PortalInvoiceListItemSchema));
}

/**
 * `GET /v1/portal/invoices/:id`. The API answers 404 for a foreign, draft or unknown id. The view
 * has no status field, so a body that looks like a draft (no number, a proforma, or a status other
 * than issued) is also answered as 404 here, never as a 502: an error page would tell the customer
 * that something exists behind the id.
 */
export function getPortalInvoice(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<CustomerInvoiceView> {
  const NotIssued = z.looseObject({}).refine((b) => {
    const o = b as Record<string, unknown>;
    return (
      o.number === null ||
      o.number === undefined ||
      o.kind === 'proforma' ||
      (typeof o.status === 'string' && o.status !== 'issued')
    );
  });
  const IssuedView = z.unknown().transform((body, ctx) => {
    if (NotIssued.safeParse(body).success) {
      throw new ApiError(404, 'GET /v1/portal/invoices/:id returned a document that is not issued');
    }
    const parsed = CustomerInvoiceViewSchema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' });
      return z.NEVER;
    }
    return parsed.data;
  });
  return call(session, `/v1/portal/invoices/${seg(id)}`, IssuedView);
}

/** What the customer sees of one invoice's money position. Only these fields are read; others are dropped. */
export const PortalSettlementSchema = InvoiceSettlementSchema.pick({
  invoiceId: true,
  currency: true,
  total: true,
  openAmount: true,
  dueDate: true,
  daysOverdue: true,
  settlement: true,
});
export type PortalSettlement = z.infer<typeof PortalSettlementSchema>;

/** `GET /v1/portal/invoices/:id/settlement`: the derived status and open amount, computed by the server. */
export function getPortalInvoiceSettlement(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<PortalSettlement> {
  return call(session, `/v1/portal/invoices/${seg(id)}/settlement`, PortalSettlementSchema);
}

/** `GET /v1/portal/invoices/:id/document`: a short-lived signed link to the frozen PDF. */
export function getPortalInvoiceLink(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<SignedLinkDto> {
  return call(session, `/v1/portal/invoices/${seg(id)}/document`, SignedLinkDtoSchema);
}

/**
 * One of the customer's payments as the portal shows it. A local strict whitelist, because the
 * staff payment DTO carries submitter, verifier, NPR value and version. The API must answer with
 * exactly these keys. `rejectionReason` is left out on purpose (a question for Kuu).
 */
export const PortalPaymentListItemSchema = z.strictObject({
  id: z.guid(),
  status: PaymentStatusSchema,
  /** The receipt number, set once Finance has verified the payment. */
  number: z.string().min(1).nullable(),
  method: PaymentMethodSchema,
  currency: CurrencySchema,
  amount: DecimalString,
  receivedOn: z.iso.date(),
  bankReference: z.string().nullable(),
});
export type PortalPaymentListItem = z.infer<typeof PortalPaymentListItemSchema>;

/** `GET /v1/portal/payments`: the customer's own payments, newest first as the API orders them. */
export function listPortalPayments(
  session: Pick<Session, 'accessToken'>,
): Promise<PortalPaymentListItem[]> {
  return call(session, '/v1/portal/payments', z.array(PortalPaymentListItemSchema));
}

// ---------------------------------------------------------------------------------------------
// Payment proof upload and payment submit
// ---------------------------------------------------------------------------------------------

const UploadStartSchema = z.object({
  documentId: z.guid(),
  versionId: z.guid(),
  uploadPath: z.string(),
});

const UPLOAD_PATH =
  /^\/v1\/portal\/payment-proofs\/[0-9a-f-]{36}\/versions\/[0-9a-f-]{36}\/content$/i;

/**
 * Stores one proof file in two steps, the way the documents kernel does it: announce the file,
 * then send its bytes with their own content type. The portal has no `documents.upload`, so the
 * API's portal route does this on the customer's behalf and fixes the owner itself. The upload
 * path the API returns is checked against a strict pattern before the bearer token is sent to it.
 * Returns the document id that goes into `proofDocumentIds`.
 */
export async function uploadPaymentProof(
  session: Pick<Session, 'accessToken'>,
  file: { filename: string; mime: string; size: number; body: ReadableStream<Uint8Array> },
): Promise<string> {
  const started = await call(session, '/v1/portal/payment-proofs', UploadStartSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filename: file.filename,
      declaredMime: file.mime,
      sizeBytes: file.size,
    }),
  });
  if (!UPLOAD_PATH.test(started.uploadPath)) {
    throw new ApiError(502, 'The API returned an upload path in an unexpected form');
  }
  const res = await apiFetch(session as Session, started.uploadPath, {
    method: 'PUT',
    headers: { 'content-type': file.mime, 'content-length': String(file.size) },
    body: file.body,
    // Node's fetch needs this to stream a request body.
    duplex: 'half',
  } as RequestInit);
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `PUT proof content failed with ${res.status}`,
      await readBody(res),
    );
  }
  return started.documentId;
}

/**
 * Submits the customer's payment with proof. The key is required, so a missing one is a compile
 * error: a retry after a timeout must reuse it so the payment cannot be recorded twice. The body is
 * parsed with the strict contract first, so nothing outside it (no customer id: the API takes the
 * customer from the signed-in user) can be sent. Any 2xx is success and its body is not read.
 */
export async function submitPortalPayment(
  session: Pick<Session, 'accessToken'>,
  body: PortalSubmitPaymentBody,
  idempotencyKey: string,
): Promise<void> {
  const checked = PortalSubmitPaymentBodySchema.parse(body);
  const res = await apiFetch(session as Session, '/v1/portal/payments', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(checked),
  });
  if (!res.ok) {
    throw new ApiError(
      res.status,
      `POST /v1/portal/payments failed with ${res.status}`,
      await readBody(res),
    );
  }
}
