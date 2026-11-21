import 'server-only';

import {
  type MoneyTotals,
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
  type ReopenInvoiceBody,
  SALES_ORDER_STATUSES,
  type SalesVatRegister,
  SalesVatRegisterQuerySchema,
  SalesVatRegisterSchema,
  type SalesOrderDetail,
  SalesOrderDetailSchema,
  type SalesOrderListItem,
  SalesOrderListItemSchema,
  type SalesOrderStatus,
  SETTLEMENT_STATUSES,
  type SubmitInvoiceBody,
} from '@bos/contracts';
import { z } from 'zod';

import { nextKey } from '@/components/p2/crm/idempotency';
import { isIdempotencyInProgress } from '@/components/p2/quote-builder/failure';

import { ApiError, apiFetch } from './api';
import { failureOf } from './api-kernel';
import { evidenceRefusalMessage } from './evidence';
import { infectedFileMessage } from './infected-file';
import { readMoneyTotals } from './money-totals';
import { currencyNotEnabledText } from './kernel-ui';
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
 *   GET  /v1/sales-orders[?status=&customerId=&q=&limit=&offset=]  bare array of SalesOrderListItem + X-Total-Count
 *   GET  /v1/sales-orders/summary[?customerId=&q=]         { total, byStatus }
 *   GET  /v1/sales-orders/:id                              SalesOrderDetail
 *   POST /v1/sales-orders                                  confirm; answers SalesOrderDetail
 *   POST /v1/sales-orders/:id/schedule-lines/:lineId/mark-billable
 *   GET  /v1/invoices[?kind=&status=&settlement=&customerId=&issuedFrom=&issuedTo=&q=&limit=&offset=]
 *                                                          bare array of InvoiceListItem + X-Total-Count
 *   GET  /v1/invoices/summary[?kind=&customerId=&issuedFrom=&issuedTo=&q=]  { total, byStatus, customers }
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

/** The most values one repeated filter carries; the API refuses more (MULTI_MAX). */
const MAX_FILTER_VALUES = 20;

/** Repeated `name=value` pairs for the values that pass `keep`, once each: a hand-edited URL never becomes a filter. */
function repeated(
  name: string,
  values: readonly string[] | undefined,
  keep: (value: string) => boolean,
): [string, string][] {
  const kept = [...new Set((values ?? []).filter(keep))].slice(0, MAX_FILTER_VALUES);
  return kept.map((value) => [name, value]);
}

function queryOfPairs(pairs: [string, string][]): string {
  const query = new URLSearchParams();
  for (const [name, value] of pairs) query.append(name, value);
  const text = query.toString();
  return text === '' ? '' : `?${text}`;
}

export interface SalesOrderPageFilter {
  /** Several statuses at once; values outside the contract are dropped. */
  status?: readonly string[] | undefined;
  /** Several customers at once; values that are not ids are dropped. */
  customerId?: readonly string[] | undefined;
  /** Order number, customer name or quotation number; the API ignores one character. */
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const searchPair = (q: string | undefined): [string, string][] =>
  q !== undefined && q.trim() !== '' ? [['q', q.trim()]] : [];

/**
 * One page of `GET /v1/sales-orders` with the number of all matches (the `X-Total-Count` header), for the list
 * screen. `listSalesOrders` stays for callers that want every row of a narrow filter.
 */
export async function listSalesOrdersPage(
  session: Session,
  filter: SalesOrderPageFilter = {},
): Promise<{ items: SalesOrderListItem[]; total: number }> {
  const pairs = [
    ...repeated('status', filter.status, (v) =>
      (SALES_ORDER_STATUSES as readonly string[]).includes(v),
    ),
    ...repeated('customerId', filter.customerId, (v) => GUID.test(v)),
    ...searchPair(filter.q),
  ];
  if (filter.limit !== undefined)
    pairs.push(['limit', String(Math.max(1, Math.floor(filter.limit)))]);
  if (filter.offset !== undefined)
    pairs.push(['offset', String(Math.max(0, Math.floor(filter.offset)))]);
  const path = `/v1/sales-orders${queryOfPairs(pairs)}`;
  const res = await apiFetch(session, path, { method: 'GET' });
  const items = await parse(res, 'GET /v1/sales-orders', z.array(SalesOrderListItemSchema));
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : Number.NaN;
  // A missing or malformed count would silently render a wrong pager, so it fails like a contract drift.
  if (!Number.isSafeInteger(total)) {
    throw new ApiError(502, 'GET /v1/sales-orders returned no valid X-Total-Count', header);
  }
  return { items, total };
}

const SalesOrdersSummarySchema = z.object({
  total: z.number().int().min(0),
  byStatus: z.object({
    draft: z.number().int().min(0),
    confirmed: z.number().int().min(0),
    completed: z.number().int().min(0),
    cancelled: z.number().int().min(0),
  }),
});
export type SalesOrdersSummary = z.infer<typeof SalesOrdersSummarySchema>;

/** `GET /v1/sales-orders/summary`: counts per status for the same `q` and customers, ignoring the status filter. */
export function getSalesOrdersSummary(
  session: Session,
  filter: Pick<SalesOrderPageFilter, 'q' | 'customerId'> = {},
): Promise<SalesOrdersSummary> {
  const pairs = [
    ...repeated('customerId', filter.customerId, (v) => GUID.test(v)),
    ...searchPair(filter.q),
  ];
  return get(session, `/v1/sales-orders/summary${queryOfPairs(pairs)}`, SalesOrdersSummarySchema);
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

export interface InvoicePageFilter {
  /** Several at once; values outside the contract are dropped. */
  kind?: readonly string[] | undefined;
  status?: readonly string[] | undefined;
  /** The derived paid / overdue state of an issued invoice. */
  settlement?: readonly string[] | undefined;
  /** Several customers at once; values that are not ids are dropped. */
  customerId?: readonly string[] | undefined;
  /** Issue date range, `YYYY-MM-DD`, both ends included. */
  issuedFrom?: string | undefined;
  issuedTo?: string | undefined;
  /** Invoice number or customer name; the API ignores one character. */
  q?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

function invoicePairs(filter: InvoicePageFilter, withStatus: boolean): [string, string][] {
  const day = (name: string, value: string | undefined): [string, string][] =>
    value !== undefined && ISO_DAY.test(value) ? [[name, value]] : [];
  return [
    ...repeated('kind', filter.kind, (v) => (INVOICE_KINDS as readonly string[]).includes(v)),
    ...(withStatus
      ? [
          ...repeated('status', filter.status, (v) =>
            (INVOICE_STATUSES as readonly string[]).includes(v),
          ),
          ...repeated('settlement', filter.settlement, (v) =>
            (SETTLEMENT_STATUSES as readonly string[]).includes(v),
          ),
        ]
      : []),
    ...repeated('customerId', filter.customerId, (v) => GUID.test(v)),
    ...day('issuedFrom', filter.issuedFrom),
    ...day('issuedTo', filter.issuedTo),
    ...searchPair(filter.q),
  ];
}

/**
 * One page of `GET /v1/invoices` with the number of all matches (the `X-Total-Count` header), for the list
 * screen. `listInvoices` stays for callers that want every row of a narrow filter.
 */
export async function listInvoicesPage(
  session: Session,
  filter: InvoicePageFilter = {},
): Promise<{ items: InvoiceListItem[]; total: number; totals: MoneyTotals | null }> {
  const pairs = invoicePairs(filter, true);
  if (filter.limit !== undefined)
    pairs.push(['limit', String(Math.max(1, Math.floor(filter.limit)))]);
  if (filter.offset !== undefined)
    pairs.push(['offset', String(Math.max(0, Math.floor(filter.offset)))]);
  const res = await apiFetch(session, `/v1/invoices${queryOfPairs(pairs)}`, { method: 'GET' });
  const items = await parse(res, 'GET /v1/invoices', z.array(InvoiceListItemSchema));
  const header = res.headers.get('x-total-count');
  const total = header !== null && /^\d+$/.test(header) ? Number(header) : Number.NaN;
  // A missing or malformed count would silently render a wrong pager, so it fails like a contract drift.
  if (!Number.isSafeInteger(total)) {
    throw new ApiError(502, 'GET /v1/invoices returned no valid X-Total-Count', header);
  }
  return { items, total, totals: readMoneyTotals(res) };
}

const InvoicesSummarySchema = z.object({
  total: z.number().int().min(0),
  byStatus: z.record(z.enum(INVOICE_STATUSES), z.number().int().min(0)),
  customers: z.array(z.object({ id: z.guid(), name: z.string() })),
});
export type InvoicesSummary = z.infer<typeof InvoicesSummarySchema>;

/** `GET /v1/invoices/summary`: counts per status for the same search, kinds, customers and dates, plus the customer choices. */
export function getInvoicesSummary(
  session: Session,
  filter: Omit<InvoicePageFilter, 'status' | 'settlement' | 'limit' | 'offset'> = {},
): Promise<InvoicesSummary> {
  return get(
    session,
    `/v1/invoices/summary${queryOfPairs(invoicePairs(filter, false))}`,
    InvoicesSummarySchema,
  );
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

/** An approved invoice back to draft; it needs a new approval before issue. */
export function reopenInvoice(
  session: Session,
  id: string,
  body: ReopenInvoiceBody,
  key: string,
): Promise<unknown> {
  return command(session, `/v1/invoices/${seg(id)}/reopen`, body, key, anyBody);
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
  | 'evidence' // evidence_policy_unmet, invalid_evidence_document, evidence_required
  | 'credit_hold' // credit_hold: the customer is over its credit limit (F1-Q20/F1-Q26)
  | 'infected' // document_infected: an evidence file the scan found infected (TR-Q12e)
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
    const infected = infectedFileMessage(err);
    if (infected !== undefined) return final('infected', infected);
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
          'Today falls outside the fiscal year this invoice belongs to, so it cannot be issued now. Ask the Founder to check the fiscal year setup.',
        );
      case 'fx_rate_stale':
        return final('stale_fx', staleFxMessage(details));
      case 'credit_hold':
        return final(
          'credit_hold',
          'This customer is over its credit limit, so the sales order is on hold. Ask someone with credit override access to override the credit hold on the opportunity, then confirm again.',
        );
      default:
        return { ...base, kind: 'stale', definite: true };
    }
  }
  const evidenceRefusal = evidenceRefusalMessage(err);
  if (evidenceRefusal !== undefined) return final('evidence', evidenceRefusal);
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
          ? (currencyNotEnabledText(err) ??
            'The platform did not accept this. Check what you entered and try again.')
          : base.message,
    };
  }
  return { ...base, kind: 'error' };
}

/** The sales VAT register of one period (`from` and `to` are inclusive AD issue dates). */
export const SalesVatPeriodSchema = SalesVatRegisterQuerySchema;

export function getSalesVatRegister(
  session: Session,
  from: string,
  to: string,
): Promise<SalesVatRegister> {
  const period = SalesVatPeriodSchema.parse({ from, to });
  return get(
    session,
    `/v1/invoices/vat-register?${new URLSearchParams(period)}`,
    SalesVatRegisterSchema,
  );
}
