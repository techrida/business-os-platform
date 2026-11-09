import 'server-only';

import {
  type AllocatePaymentBody,
  AllocationDtoSchema,
  ArAgingReportSchema,
  CustomerAdvanceSchema,
  type DeallocateBody,
  InvoiceSettlementSchema,
  PaymentDtoSchema,
  PaymentListItemSchema,
  type PaymentStatus,
  type RejectPaymentBody,
  type ReversePaymentBody,
  type SubmitPaymentBody,
  type VerifyPaymentBody,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the payment and receivable routes (P3 U7 and U8). Server-only:
 * every call carries the user's access token. Each response is parsed with the contract's schema, so
 * an API that drifts fails loudly (502) instead of rendering `undefined`.
 *
 * Serves plan A8: what is paid, open or overdue is derived on the server. Nothing here adds up
 * money; the screens show the strings these calls return.
 *
 * Every command takes its `Idempotency-Key` as a required argument, so a missing key is a compile
 * error. Keeping the same key across a timeout or the in-progress 409 is the caller's job.
 *
 * Paths are assumed (the routes are not built yet): payments live at `/v1/payments`, the ledger
 * reads at `/v1/receivables`.
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

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

async function call<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
  init?: RequestInit,
): Promise<T> {
  const res = await apiFetch(session, path, init);
  const body = await readBody(res);
  const label = `${init?.method ?? 'GET'} ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

function command(body: unknown, key: string): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  };
}

function withQuery(path: string, params: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params))
    if (value !== undefined) query.set(name, value);
  return query.size > 0 ? `${path}?${query.toString()}` : path;
}

// ---------------------------------------------------------------------------------------------
// Payments
// ---------------------------------------------------------------------------------------------

/** `GET /v1/payments[?status=]`: a bare array of list rows. */
export function listPayments(session: Session, status?: PaymentStatus) {
  return call(session, withQuery('/v1/payments', { status }), z.array(PaymentListItemSchema));
}

/** `GET /v1/payments/:id`. */
export function getPayment(session: Session, id: string) {
  return call(session, `/v1/payments/${seg(id)}`, PaymentDtoSchema);
}

/** `GET /v1/payments/:id/allocations`: every row, reversals included (append-only). */
export function listPaymentAllocations(session: Session, id: string) {
  return call(session, `/v1/payments/${seg(id)}/allocations`, z.array(AllocationDtoSchema));
}

/** `POST /v1/payments`: staff entry. The customer is named in the body. */
export function submitPayment(session: Session, body: SubmitPaymentBody, key: string) {
  return call(session, '/v1/payments', PaymentDtoSchema, command(body, key));
}

/** `POST /v1/payments/:id/verify`. The server refuses (403) the person who recorded the payment. */
export function verifyPayment(session: Session, id: string, body: VerifyPaymentBody, key: string) {
  return call(session, `/v1/payments/${seg(id)}/verify`, PaymentDtoSchema, command(body, key));
}

/** `POST /v1/payments/:id/reject`. A reason is required. */
export function rejectPayment(session: Session, id: string, body: RejectPaymentBody, key: string) {
  return call(session, `/v1/payments/${seg(id)}/reject`, PaymentDtoSchema, command(body, key));
}

/** `POST /v1/payments/:id/reverse`: a bounced cheque or an erroneous receipt. Deallocates first. */
export function reversePayment(
  session: Session,
  id: string,
  body: ReversePaymentBody,
  key: string,
) {
  return call(session, `/v1/payments/${seg(id)}/reverse`, PaymentDtoSchema, command(body, key));
}

/** `POST /v1/payments/:id/allocations`: spread a verified payment over open invoices. */
export function allocatePayment(
  session: Session,
  id: string,
  body: AllocatePaymentBody,
  key: string,
) {
  return call(
    session,
    `/v1/payments/${seg(id)}/allocations`,
    z.array(AllocationDtoSchema),
    command(body, key),
  );
}

/** `POST /v1/payments/:id/allocations/:allocationId/reverse`: a deallocation is a reversal row. */
export function deallocate(
  session: Session,
  id: string,
  allocationId: string,
  body: DeallocateBody,
  key: string,
) {
  return call(
    session,
    `/v1/payments/${seg(id)}/allocations/${seg(allocationId)}/reverse`,
    AllocationDtoSchema,
    command(body, key),
  );
}

// ---------------------------------------------------------------------------------------------
// Receivables
// ---------------------------------------------------------------------------------------------

/** `GET /v1/receivables/aging`: buckets by customer and currency, as of Kathmandu "today". */
export function getAging(session: Session) {
  return call(session, '/v1/receivables/aging', ArAgingReportSchema);
}

/**
 * `GET /v1/receivables/customers/:id/statement[?open=true&currency=]`: the customer's invoices with
 * their derived settlement. `open` keeps only items with an open amount; `currency` narrows them.
 */
export function getCustomerStatement(
  session: Session,
  customerId: string,
  filter: { openOnly?: boolean; currency?: string } = {},
) {
  return call(
    session,
    withQuery(`/v1/receivables/customers/${seg(customerId)}/statement`, {
      open: filter.openOnly === true ? 'true' : undefined,
      currency: filter.currency,
    }),
    z.array(InvoiceSettlementSchema),
  );
}

/** `GET /v1/receivables/customers/:id/advance`: unallocated credit, one row per currency. */
export function getCustomerAdvance(session: Session, customerId: string) {
  return call(
    session,
    `/v1/receivables/customers/${seg(customerId)}/advance`,
    z.array(CustomerAdvanceSchema),
  );
}
