import 'server-only';

import {
  CustomerDtoSchema,
  VerificationCaseDtoSchema,
  type CustomerDto,
  type ReviewVerificationBody,
  type VerificationCaseDto,
  type VerificationStatus,
} from '@bos/contracts';
import { z } from 'zod';

import { ApiError, apiFetch } from '@/lib/api';
import type { Session } from '@/lib/session';

/**
 * Typed calls from the workspace BFF to the P2 customer and KYB routes. Server-only: every call
 * carries the user's access token. Each response is parsed with the contracts' schemas, so an API
 * that drifts from the contract fails here (502) instead of rendering `undefined`.
 *
 * The routes do not exist on the API yet. The list envelope is not in the contracts, so a list may
 * come back as a bare array (like `/v1/approvals/inbox`) or as `{ items, total? }` (like the audit
 * log); both parse. Failures are worded by `failureOf` from `@/lib/api-kernel`.
 */

export interface Listing<T> {
  items: T[];
  /** The full count when the API sends it, so the page can say "of 41"; otherwise null. */
  total: number | null;
}

function listingOf<T extends z.ZodType>(item: T) {
  return z
    .union([
      z.array(item),
      z.object({ items: z.array(item), total: z.number().int().min(0).optional() }),
    ])
    .transform((body): Listing<z.infer<T>> =>
      Array.isArray(body)
        ? { items: body, total: null }
        : { items: body.items, total: body.total ?? null },
    );
}

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

function withQuery(path: string, params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '') query.set(key, String(value));
  }
  const text = query.toString();
  return text === '' ? path : `${path}?${text}`;
}

// ---------------------------------------------------------------------------------------------
// Customers
// ---------------------------------------------------------------------------------------------

/** `GET /v1/customers?q=&limit=&offset=`. `q` is the search text (name, number, PAN/VAT). */
export function listCustomers(
  session: Session,
  query: { q?: string; limit?: number; offset?: number },
): Promise<Listing<CustomerDto>> {
  return call(
    session,
    withQuery('/v1/customers', { q: query.q, limit: query.limit, offset: query.offset }),
    listingOf(CustomerDtoSchema),
  );
}

export function getCustomer(session: Session, id: string): Promise<CustomerDto> {
  return call(session, `/v1/customers/${seg(id)}`, CustomerDtoSchema);
}

// ---------------------------------------------------------------------------------------------
// Verification (KYB)
// ---------------------------------------------------------------------------------------------

/** `GET /v1/verification-cases?status=&partyId=`. */
export function listVerificationCases(
  session: Session,
  query: { status?: VerificationStatus; partyId?: string },
): Promise<Listing<VerificationCaseDto>> {
  return call(
    session,
    withQuery('/v1/verification-cases', { status: query.status, partyId: query.partyId }),
    listingOf(VerificationCaseDtoSchema),
  );
}

export function getVerificationCase(session: Session, id: string): Promise<VerificationCaseDto> {
  return call(session, `/v1/verification-cases/${seg(id)}`, VerificationCaseDtoSchema);
}

/**
 * `POST /v1/verification-cases/:id/decision`. The key is a required argument, as for approvals,
 * so a double click or a retry after a timeout cannot decide the case twice.
 */
export function decideVerification(
  session: Session,
  id: string,
  body: ReviewVerificationBody,
  idempotencyKey: string,
): Promise<VerificationCaseDto> {
  return call(session, `/v1/verification-cases/${seg(id)}/decision`, VerificationCaseDtoSchema, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
}
