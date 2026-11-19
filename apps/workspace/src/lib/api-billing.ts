import 'server-only';

import {
  type ConfirmSalesOrderBody,
  type CreateManualInvoiceBody,
  type CreditNoteBody,
  CURRENCIES,
  type DebitNoteBody,
  type DiscardInvoiceBody,
  type DraftFromScheduleBody,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  type InvoiceDetail,
  InvoiceDetailSchema,
  type InvoiceKind,
  type InvoiceListItem,
  InvoiceListItemSchema,
  type InvoiceStatus,
  type IssueInvoiceBody,
  type IssueInvoiceResult,
  IssueInvoiceResultSchema,
  type MarkBillableBody,
  SALES_ORDER_STATUSES,
  type SalesOrderDetail,
  SalesOrderDetailSchema,
  type SalesOrderListItem,
  SalesOrderListItemSchema,
  type SalesOrderStatus,
  type SubmitInvoiceBody,
} from '@bos/contracts';
import { z } from 'zod';

import { nextKey } from '@/components/p2/crm/idempotency';
import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';

import { ApiError, apiFetch } from './api';
import { failureOf } from './api-kernel';
import type { Session } from './session';

/**
 * Typed calls from the workspace to the P3 sales-order and invoice endpoints, plus the words for
 * the billing refusals. Server-only: every call carries the user's access token. Each response is
 * parsed with the contract's schema, so an API that drifts from the contract fails loudly (502)
 * instead of rendering `undefined`. Serves the NFR "amounts are exact": money stays a string and
 * nothing here computes it; totals, numbers and the issue date come back from the server.
 *
 * The routes are not built yet. The paths below are the assumption this file makes, in one place,
 * so the API can be matched to them or this file edited once.
 *   GET  /v1/sales-orders[?status=&customerId=]            bare array of SalesOrderListItem
 *   GET  /v1/sales-orders/:id                              SalesOrderDetail
 *   POST /v1/sales-orders                                  confirm; answers SalesOrderDetail
 *   POST /v1/sales-orders/:id/schedule-lines/:lineId/mark-billable
 *   GET  /v1/invoices[?kind=&status=&customerId=]          bare array of InvoiceListItem
 *   GET  /v1/invoices/:id                                  InvoiceDetail
 *   POST /v1/invoices                                      manual draft; answers InvoiceDetail
 *   POST /v1/invoices/from-schedule                        draft from a billable line; InvoiceDetail
 *   POST /v1/invoices/:id/{submit,discard,issue}           issue answers IssueInvoiceResult
 *   POST /v1/credit-notes, POST /v1/debit-notes            answer InvoiceDetail
 *   GET  /v1/invoices/:id/document                         signed PDF link (issued only)
 */

/** The Idempotency-Key the next try sends: kept after an unknown outcome or the in-progress 409, new after a final answer. */
export const keyAfterFailure = nextKey;

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

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9-]{8,64}$/;

async function parse<T>(res: Response, label: string, schema: z.ZodType<T>): Promise<T> {
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape the contract promises.
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

async function get<T>(session: Session, path: string, schema: z.ZodType<T>): Promise<T> {
  const res = await apiFetch(session, path, { method: 'GET' });
  return parse(res, `GET ${path.split('?')[0] ?? path}`, schema);
}

/**
 * POSTs one command. The key is explicit and checked: a key that is not a UUID-like token would let
 * two different requests collide, so it never leaves this file. Whoever calls keeps the key across a
 * timeout or an in-progress 409 and rotates it only after a final answer (`keyAfterFailure`).
 */
async function command<T>(
  session: Session,
  path: string,
  body: unknown,
  key: string,
  schema: z.ZodType<T>,
): Promise<T> {
  if (!IDEMPOTENCY_KEY.test(key)) throw new TypeError('The Idempotency-Key is not a valid key.');
  const res = await apiFetch(session, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  });
  return parse(res, `POST ${path}`, schema);
}

/** Commands whose answer a screen does not need: success is "the API answered 2xx". */
const anyBody = z.unknown();

/** `?a=b` from the entries that are set, or an empty string. */
function queryOf(entries: [string, string | undefined][]): string {
  const query = new URLSearchParams();
  for (const [name, value] of entries) if (value !== undefined) query.set(name, value);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

/** The value if it is one of `allowed`, else undefined: a hand-edited URL never becomes a filter. */
function oneOf<T extends string>(allowed: readonly T[], value: string | undefined): T | undefined {
  return value !== undefined && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : undefined;
}

const guidOrUndefined = (value: string | undefined): string | undefined =>
  value !== undefined && GUID.test(value) ? value : undefined;

// ---------------------------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------------------------

export interface SalesOrderFilter {
  quotationVersionId?: string | undefined;
  status?: SalesOrderStatus | undefined;
  customerId?: string | undefined;
}

export function listSalesOrders(
  session: Session,
  filter: SalesOrderFilter = {},
): Promise<SalesOrderListItem[]> {
  const query = queryOf([
    ['status', oneOf(SALES_ORDER_STATUSES, filter.status)],
    ['quotationVersionId', guidOrUndefined(filter.quotationVersionId)],
    ['customerId', guidOrUndefined(filter.customerId)],
  ]);
  return get(session, `/v1/sales-orders${query}`, z.array(SalesOrderListItemSchema));
}

export function getSalesOrder(session: Session, id: string): Promise<SalesOrderDetail> {
  return get(session, `/v1/sales-orders/${seg(id)}`, SalesOrderDetailSchema);
}

export interface InvoiceFilter {
  kind?: InvoiceKind | undefined;
  status?: InvoiceStatus | undefined;
  customerId?: string | undefined;
}

export function listInvoices(
  session: Session,
  filter: InvoiceFilter = {},
): Promise<InvoiceListItem[]> {
  const query = queryOf([
    ['kind', oneOf(INVOICE_KINDS, filter.kind)],
    ['status', oneOf(INVOICE_STATUSES, filter.status)],
    ['customerId', guidOrUndefined(filter.customerId)],
  ]);
  return get(session, `/v1/invoices${query}`, z.array(InvoiceListItemSchema));
}

export function getInvoice(session: Session, id: string): Promise<InvoiceDetail> {
  return get(session, `/v1/invoices/${seg(id)}`, InvoiceDetailSchema);
}

/** The API path that issues a single-use signed link to an issued invoice's PDF. */
export function invoiceDocumentPath(id: string): string {
  return `/v1/invoices/${seg(id)}/document`;
}

// ---------------------------------------------------------------------------------------------
// Commands (every one takes the Idempotency-Key explicitly)
// ---------------------------------------------------------------------------------------------

/** Confirm an accepted quotation version as a sales order. */
export function confirmSalesOrder(
  session: Session,
  body: ConfirmSalesOrderBody,
  key: string,
): Promise<SalesOrderDetail> {
  return command(session, '/v1/sales-orders', body, key, SalesOrderDetailSchema);
}

/** `expectedVersion` is the order's version: schedule lines carry no version of their own. */
export function markScheduleLineBillable(
  session: Session,
  salesOrderId: string,
  scheduleLineId: string,
  body: MarkBillableBody,
  key: string,
): Promise<unknown> {
  return command(
    session,
    `/v1/sales-orders/${seg(salesOrderId)}/schedule-lines/${seg(scheduleLineId)}/mark-billable`,
    body,
    key,
    anyBody,
  );
}

/** A line already drafted answers 409 `SCHEDULE_LINE_TAKEN`. */
export function draftInvoiceFromSchedule(
  session: Session,
  body: DraftFromScheduleBody,
  key: string,
): Promise<InvoiceDetail> {
  return command(session, '/v1/invoices/from-schedule', body, key, InvoiceDetailSchema);
}

/** The body carries quantities, prices and tax codes only; the server prices the lines. */
export function createManualInvoice(
  session: Session,
  body: CreateManualInvoiceBody,
  key: string,
): Promise<InvoiceDetail> {
  return command(session, '/v1/invoices', body, key, InvoiceDetailSchema);
}

export function submitInvoice(
  session: Session,
  id: string,
  body: SubmitInvoiceBody,
  key: string,
): Promise<unknown> {
  return command(session, `/v1/invoices/${seg(id)}/submit`, body, key, anyBody);
}

export function discardInvoice(
  session: Session,
  id: string,
  body: DiscardInvoiceBody,
  key: string,
): Promise<unknown> {
  return command(session, `/v1/invoices/${seg(id)}/discard`, body, key, anyBody);
}

/** `issued` and `already_issued` are both results, never errors (a replay or a double click). */
export function issueInvoice(
  session: Session,
  id: string,
  body: IssueInvoiceBody,
  key: string,
): Promise<IssueInvoiceResult> {
  return command(session, `/v1/invoices/${seg(id)}/issue`, body, key, IssueInvoiceResultSchema);
}

export function createCreditNote(
  session: Session,
  body: CreditNoteBody,
  key: string,
): Promise<InvoiceDetail> {
  return command(session, '/v1/credit-notes', body, key, InvoiceDetailSchema);
}

export function createDebitNote(
  session: Session,
  body: DebitNoteBody,
  key: string,
): Promise<InvoiceDetail> {
  return command(session, '/v1/debit-notes', body, key, InvoiceDetailSchema);
}

/** What to tell the person after `issue` answered. Both results are a success. */
export function issueOutcomeMessage(result: IssueInvoiceResult): string {
  return result.kind === 'issued'
    ? `Issued as ${result.number}.`
    : `Already issued as ${result.number}. Nothing changed.`;
}

// ---------------------------------------------------------------------------------------------
// Failure words
// ---------------------------------------------------------------------------------------------

export type BillingFailureKind =
  | 'line_taken' // SCHEDULE_LINE_TAKEN: the line already has a draft invoice
  | 'not_approved' // NOT_APPROVED
  | 'period_mismatch' // PERIOD_FY_MISMATCH
  | 'stale_fx' // fx_rate_stale
  | 'evidence' // evidence_policy_unmet
  | 'in_progress' // the first request with this key has not settled
  | 'stale' // the row version moved: reload
  | 'forbidden'
  | 'not_found'
  | 'invalid'
  | 'session'
  | 'error';

export interface BillingFailure {
  kind: BillingFailureKind;
  message: string;
  /** The page is out of date: offer a reload. */
  reload: boolean;
  /** A final answer (4xx): the next click is a new decision. False when the outcome is unknown. */
  definite: boolean;
}

const CURRENCY = new Set<string>(CURRENCIES);
const DAY = /^\d{4}-\d{2}-\d{2}$/;

function errorCode(err: unknown): { code: string; details: Record<string, unknown> } {
  const body = err instanceof ApiError ? (err.body as { error?: Record<string, unknown> }) : null;
  const error = body?.error;
  const code = typeof error?.code === 'string' ? error.code : '';
  const d = error?.details;
  const details =
    typeof d === 'object' && d !== null && !Array.isArray(d) ? (d as Record<string, unknown>) : {};
  return { code, details };
}

/** Only a known currency code, a plain date and a whole number of days are echoed from `details`. */
function staleFxMessage(details: Record<string, unknown>): string {
  const currency =
    typeof details['currency'] === 'string' && CURRENCY.has(details['currency'])
      ? details['currency']
      : undefined;
  const rateDate =
    typeof details['rateDate'] === 'string' && DAY.test(details['rateDate'])
      ? details['rateDate']
      : undefined;
  const maxAge =
    typeof details['maxAgeDays'] === 'number' && Number.isInteger(details['maxAgeDays'])
      ? details['maxAgeDays']
      : undefined;
  const what = currency !== undefined ? `The ${currency} exchange rate` : 'The exchange rate';
  const from = rateDate !== undefined ? ` on file is from ${rateDate}` : ' on file';
  const limit = maxAge !== undefined ? `, more than ${maxAge} days old,` : ', which is too old,';
  return `${what}${from}${limit} so this invoice cannot be issued. Ask Finance to enter today's rate, then issue it again.`;
}

/**
 * Turns a thrown value from a billing call into words and flags. Billing codes first, then the
 * kernel's wording for everything else (403 reasons, 404, 401, 5xx). Unknown 409s ask for a reload,
 * because the row version moved. Serves the NFR "errors name the problem and the recovery".
 */
export function describeBillingFailure(err: unknown): BillingFailure {
  const base = failureOf(err);
  const { code, details } = errorCode(err);
  const status = base.status;
  const final = (kind: BillingFailureKind, message: string, reload = false): BillingFailure => ({
    kind,
    message,
    reload,
    definite: true,
  });

  if (status === 409 && isIdempotencyInProgress(err)) {
    return {
      kind: 'in_progress',
      message: 'Your first click is still being processed. Wait a moment, then try again.',
      reload: false,
      definite: false,
    };
  }
  if (status === 409) {
    switch (code) {
      case 'SCHEDULE_LINE_TAKEN':
        return final(
          'line_taken',
          'This billing line already has an invoice drafted. Open that invoice instead of starting a second one.',
        );
      case 'NOT_APPROVED':
        return final(
          'not_approved',
          'This invoice is not approved yet, so it cannot be issued. Wait for the approvers, then try again.',
          true,
        );
      case 'PERIOD_FY_MISMATCH':
        return final(
          'period_mismatch',
          'Today falls outside the fiscal year this invoice belongs to, so it cannot be issued now. Ask Finance to check the fiscal year setup.',
        );
      case 'fx_rate_stale':
        return final('stale_fx', staleFxMessage(details));
      default:
        return { ...base, kind: 'stale', definite: true };
    }
  }
  if (status === 422 && code === 'evidence_policy_unmet') {
    return final(
      'evidence',
      'The evidence this step needs is missing. Attach the required document (the customer purchase order, a contract or the signed quotation), then try again.',
    );
  }
  if (status === 401) return { ...base, kind: 'session', definite: true };
  if (status === 403) return { ...base, kind: 'forbidden', definite: true };
  if (status === 404) return { ...base, kind: 'not_found', definite: true };
  if (status === 400 || status === 422) {
    return {
      ...base,
      kind: 'invalid',
      message:
        status === 422
          ? 'The platform did not accept this. Check what you entered and try again.'
          : base.message,
    };
  }
  return { ...base, kind: 'error' };
}
