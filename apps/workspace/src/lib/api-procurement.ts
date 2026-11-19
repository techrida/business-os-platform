import 'server-only';

import {
  CostCenterSchema,
  CurrencySchema,
  PrRequestTypeSchema,
  PrStatusSchema,
  type CreatePurchaseRequestBody,
  type PrStatus,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from './api';
import type { Session } from './session';

/**
 * Typed calls from the workspace BFF to the P4 procurement routes: purchase requests
 * (`/v1/procurement/purchase-requests`). Server-only: every call carries the user's access token.
 * The contracts hold the request bodies but no response schemas yet, so the schemas below mirror
 * `PurchaseRequestListItem` and `PurchaseRequestDto` in `apps/api` (`purchase-request.rules.ts`).
 * A response that drifts from them fails here (502) instead of rendering `undefined`.
 *
 * Money and quantities are strings the server computed; nothing in this file adds or multiplies.
 * Every write takes the Idempotency-Key as a required argument (the API answers 400 without
 * one), so a missing key is a compile error. That includes PATCH, which the API also keys.
 */

const money = z.string().regex(/^-?\d+(\.\d+)?$/);

export const PurchaseRequestLineSchema = z.object({
  id: z.guid(),
  lineNo: z.number().int().min(1),
  description: z.string(),
  specification: z.string().nullable(),
  requiresSerials: z.boolean().optional(),
  uom: z.string(),
  quantity: money,
  estimatedUnitPrice: money,
  estimatedAmount: money,
});
export type PurchaseRequestLine = z.infer<typeof PurchaseRequestLineSchema>;

export const PurchaseRequestListItemSchema = z.object({
  id: z.guid(),
  /** Null until submit: the number is taken from the series then. */
  number: z.string().nullable(),
  requestType: PrRequestTypeSchema,
  departmentId: z.guid(),
  requesterUserId: z.string(),
  costCenterId: z.guid(),
  justification: z.string(),
  requiredBy: z.string(),
  deliveryLocation: z.string().nullable(),
  budgetCode: z.string(),
  projectId: z.guid().nullable(),
  currency: CurrencySchema,
  estimatedTotal: money,
  /** The NPR estimate and its FX snapshot: null while a draft or returned for edit. */
  estimatedTotalNpr: money.nullable(),
  fxRate: z.string().nullable(),
  fxSource: z.string().nullable(),
  fxDate: z.string().nullable(),
  isEmergency: z.boolean(),
  emergencyReason: z.string().nullable(),
  status: PrStatusSchema,
  approvalRequestId: z.guid().nullable(),
  /** The live RFQ opened on this request, if any. Defaults to null so an older answer still parses. */
  rfqId: z.guid().nullable().default(null),
  submittedAt: z.string().nullable(),
  version: z.number().int().min(1),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type PurchaseRequestListItem = z.infer<typeof PurchaseRequestListItemSchema>;

export const PurchaseRequestDtoSchema = PurchaseRequestListItemSchema.extend({
  lines: z.array(PurchaseRequestLineSchema),
});
export type PurchaseRequestDto = z.infer<typeof PurchaseRequestDtoSchema>;

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
export const seg = (id: string): string => encodeURIComponent(id);

export async function call<T>(
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

export function jsonInit(method: string, body: unknown, key: string): RequestInit {
  return {
    method,
    headers: { 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(body),
  };
}

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(name, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

/** Like `withQuery`, but an array value repeats the key (`status=a&status=b`), which is how multi-select filters travel. */
export function listQuery(
  path: string,
  params: Record<string, string | number | readonly string[] | undefined>,
): string {
  const query = new URLSearchParams();
  for (const [name, value] of Object.entries(params)) {
    if (value === undefined) continue;
    if (typeof value === 'object') {
      for (const item of value) if (item !== '') query.append(name, item);
    } else if (value !== '') query.set(name, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

/**
 * A list endpoint that answers a bare array plus `X-Total-Count` (all matches, not just this page). A missing or
 * unreadable header falls back to the row count, so a page never claims more rows than it can show.
 */
export async function callList<T>(
  session: Session,
  path: string,
  schema: z.ZodType<T>,
): Promise<{ items: T[]; total: number }> {
  const res = await apiFetch(session, path);
  const body = await readBody(res);
  const label = `GET ${path.split('?')[0] ?? path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = z.array(schema).safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  const header = Number(res.headers.get('x-total-count'));
  const total =
    Number.isInteger(header) && header >= parsed.data.length ? header : parsed.data.length;
  return { items: parsed.data, total };
}

// ------------------------------------------------------------------------- purchase requests

const PR_PATH = '/v1/procurement/purchase-requests';

/**
 * `GET /v1/procurement/purchase-requests?status=&limit=` (needs `procurement.pr.read`): a bare
 * array, newest first. The API's query is strict (only `status` and `limit`, at most 200), and
 * it decides "own or all" from the caller's grant, so nothing else is sent.
 */
export function listPurchaseRequests(
  session: Session,
  query: { status?: PrStatus; limit?: number },
): Promise<PurchaseRequestListItem[]> {
  return call(
    session,
    withQuery(PR_PATH, {
      status: query.status !== undefined ? PrStatusSchema.parse(query.status) : undefined,
      limit: query.limit,
    }),
    z.array(PurchaseRequestListItemSchema),
  );
}

/**
 * One page of `GET /v1/procurement/purchase-requests` with several statuses, a search and `offset`, plus the total of
 * all matches from `X-Total-Count`. The API scopes the rows to what the caller may read; nothing here widens that.
 */
export function listPurchaseRequestsPage(
  session: Session,
  query: { status?: readonly PrStatus[]; q?: string; limit: number; offset: number },
): Promise<{ items: PurchaseRequestListItem[]; total: number }> {
  return callList(
    session,
    listQuery(PR_PATH, {
      status: query.status?.map((s) => PrStatusSchema.parse(s)),
      q: query.q,
      limit: query.limit,
      offset: query.offset,
    }),
    PurchaseRequestListItemSchema,
  );
}

/** `GET /v1/procurement/purchase-requests/:id`: 404 outside the caller's entity or scope. */
export function getPurchaseRequest(session: Session, id: string): Promise<PurchaseRequestDto> {
  return call(session, `${PR_PATH}/${seg(id)}`, PurchaseRequestDtoSchema);
}

/** `POST /v1/procurement/purchase-requests` (needs `procurement.pr.create`): 201 with the draft. */
export function createPurchaseRequest(
  session: Session,
  body: CreatePurchaseRequestBody,
  idempotencyKey: string,
): Promise<PurchaseRequestDto> {
  return call(session, PR_PATH, PurchaseRequestDtoSchema, jsonInit('POST', body, idempotencyKey));
}

/**
 * `PATCH /v1/procurement/purchase-requests/:id`: replaces a draft or returned request with the
 * whole create body (plus `expectedVersion`). 409 once submitted or when the version is stale.
 */
export function updatePurchaseRequest(
  session: Session,
  id: string,
  body: CreatePurchaseRequestBody,
  idempotencyKey: string,
  expectedVersion?: number,
): Promise<PurchaseRequestDto> {
  return call(
    session,
    `${PR_PATH}/${seg(id)}`,
    PurchaseRequestDtoSchema,
    jsonInit(
      'PATCH',
      expectedVersion !== undefined ? { ...body, expectedVersion } : body,
      idempotencyKey,
    ),
  );
}

const commandBody = (expectedVersion: number | undefined) =>
  expectedVersion !== undefined ? { expectedVersion } : {};

/**
 * `POST .../:id/submit`: draft or returned to submitted. 422 `NO_ELIGIBLE_APPROVER` when a step
 * has nobody who may decide it (nothing is submitted); 409 when the status or version moved.
 */
export function submitPurchaseRequest(
  session: Session,
  id: string,
  idempotencyKey: string,
  expectedVersion?: number,
): Promise<PurchaseRequestDto> {
  return call(
    session,
    `${PR_PATH}/${seg(id)}/submit`,
    PurchaseRequestDtoSchema,
    jsonInit('POST', commandBody(expectedVersion), idempotencyKey),
  );
}

/** `POST .../:id/cancel`: a draft only; 409 otherwise. */
export function cancelPurchaseRequest(
  session: Session,
  id: string,
  idempotencyKey: string,
  expectedVersion?: number,
): Promise<PurchaseRequestDto> {
  return call(
    session,
    `${PR_PATH}/${seg(id)}/cancel`,
    PurchaseRequestDtoSchema,
    jsonInit('POST', commandBody(expectedVersion), idempotencyKey),
  );
}

/** Existing staff-only, acting-entity lookup used by purchase request entry. */
export function listDepartments(session: Session): Promise<{ id: string; name: string }[]> {
  return call(session, '/v1/departments', z.array(z.object({ id: z.guid(), name: z.string() })));
}

/** Cost centres of the acting entity, including inactive entries retained on existing requests. */
export function listCostCenters(session: Session) {
  return call(session, '/v1/cost-centers', z.array(CostCenterSchema));
}
