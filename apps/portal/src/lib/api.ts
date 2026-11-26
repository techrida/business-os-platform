import 'server-only';

import { randomUUID } from 'node:crypto';

import {
  type AcceptQuotationBody,
  CUSTOMER_VISIBLE_STATUSES,
  type CustomerQuotationView,
  CustomerQuotationViewSchema,
  dropUnknownGrants,
  MeResponseSchema,
  type PortalDisplay,
  PortalDisplaySchema,
  type PortalQuotationListItem,
  PortalQuotationListItemSchema,
  type RejectQuotationBody,
  type SignedLinkDto,
  SignedLinkDtoSchema,
} from '@bos/contracts';
import { headers as requestHeaders } from 'next/headers';
import { z } from 'zod';

import { getEnv } from './env';
import type { Session } from './session';

// The request bodies live in @bos/contracts. Re-exported so the portal's actions and tests keep
// importing them from here.
export { AcceptQuotationBodySchema, RejectQuotationBodySchema } from '@bos/contracts';

/**
 * Server-to-server calls from the portal BFF to the API. Copied from apps/workspace (dedupe later).
 * `server-only` makes any import from a Client Component a build error, because these helpers
 * attach the user's access token.
 */

export class ApiError extends Error {
  readonly status: number;
  readonly body?: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    if (body !== undefined) this.body = body;
  }
}

/**
 * Resolves `path` against API_INTERNAL_URL and refuses anything that lands on another origin.
 * Without this, an absolute URL or `//host` passed as `path` would send the bearer token there.
 */
function apiUrl(path: string): URL {
  const base = new URL(getEnv().API_INTERNAL_URL);
  if (!path.startsWith('/') || path.startsWith('//') || path.includes('\\')) {
    throw new ApiError(0, 'api path must be a relative path starting with a single /');
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin) throw new ApiError(0, 'api path resolved to another origin');
  return url;
}

/** A web-to-API call gets this long unless the caller passes its own signal. */
export const API_TIMEOUT_MS = 15_000;

/** The API's correlation id rule, so a reused id is never refused or replaced there. */
const REQUEST_ID_PATTERN = /^[A-Za-z0-9-]{8,64}$/;

/** What the browser's own request told the BFF, as Caddy passed it on. Empty outside a request. */
async function incomingContext(): Promise<{
  requestId?: string;
  forwardedFor?: string;
  userAgent?: string;
}> {
  let incoming: Headers;
  try {
    incoming = await requestHeaders();
  } catch {
    // Outside a request scope (a script, a test): there is no browser request to describe.
    return {};
  }
  const requestId = incoming.get('x-request-id');
  const forwardedFor = incoming.get('x-forwarded-for');
  const userAgent = incoming.get('user-agent');
  return {
    ...(requestId !== null && REQUEST_ID_PATTERN.test(requestId) ? { requestId } : {}),
    ...(forwardedFor ? { forwardedFor } : {}),
    ...(userAgent ? { userAgent } : {}),
  };
}

/**
 * What a call that outlasted its deadline looks like to the callers: the same 503 `db_busy` refusal
 * the API sends when it is overloaded, so the existing "busy, try again" handling shows it.
 */
function timeoutAsBusy(requestId: string): ApiError {
  return new ApiError(503, `API did not answer within ${API_TIMEOUT_MS / 1000} s`, {
    error: {
      code: 'db_busy',
      message: 'The platform is busy. Try again in a moment.',
      correlationId: requestId,
      details: { retryAfterSeconds: 1 },
    },
  });
}

/** Async so a bad path rejects the promise instead of throwing synchronously at the call site. */
async function authedFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = apiUrl(path);
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  const incoming = await incomingContext();
  // One id per browser request, so the web log, the API log and the audit row line up. A UUID fits
  // the API's `^[A-Za-z0-9-]{8,64}$` correlation id rule. Without an incoming id, a fresh one.
  const requestId = incoming.requestId ?? randomUUID();
  headers.set('x-request-id', requestId);
  // The API trusts one proxy hop (this one), so it reads the address as the last entry of this header.
  // Set or dropped here, never passed through from the caller's `init`, which could forge it.
  headers.delete('x-forwarded-for');
  headers.delete('user-agent');
  if (incoming.forwardedFor !== undefined) headers.set('x-forwarded-for', incoming.forwardedFor);
  if (incoming.userAgent !== undefined) headers.set('user-agent', incoming.userAgent);
  const ownSignal = init?.signal ?? undefined;
  const signal = ownSignal ?? AbortSignal.timeout(API_TIMEOUT_MS);
  try {
    // Responses are per user: never let Next's data cache keep or share them.
    return await fetch(url, { ...init, headers, signal, cache: 'no-store' });
  } catch (err) {
    // Only our own deadline becomes the busy refusal; a caller's abort stays the caller's.
    if (ownSignal === undefined && err instanceof Error && err.name === 'TimeoutError') {
      throw timeoutAsBusy(requestId);
    }
    throw err;
  }
}

/** Calls the API as the session's user. Errors never include the token. */
export function apiFetch(session: Session, path: string, init?: RequestInit): Promise<Response> {
  return authedFetch(session.accessToken, path, init);
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

/**
 * `/v1/me` as the portal reads it: the shared contract plus `partyId`, which ADR 0027 adds for
 * portal users (null for staff). Local until the shared MeResponseSchema carries it; a body
 * without it parses with `partyId` undefined, and the callback then refuses the sign-in.
 */
export const PortalMeSchema = MeResponseSchema.extend({
  partyId: z.guid().nullable().optional(),
});
export type PortalMe = z.infer<typeof PortalMeSchema>;

/** `GET /v1/me`, validated against the contract above. Throws `ApiError` on any mismatch. */
export async function getMe(session: Pick<Session, 'accessToken'>): Promise<PortalMe> {
  const res = await authedFetch(session.accessToken, '/v1/me', { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET /v1/me failed with ${res.status}`, body);
  // A newer API may send a permission or scope this build has no name for: drop those rows, warn, keep signing in.
  const { body: known, dropped } = dropUnknownGrants(body);
  if (dropped.length > 0) {
    console.warn(JSON.stringify({ event: 'me.unknown_grants_dropped', dropped }));
  }
  const parsed = PortalMeSchema.safeParse(known);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape we agreed on.
    throw new ApiError(502, 'GET /v1/me returned an invalid body', parsed.error.issues);
  }
  return parsed.data;
}

// ---------------------------------------------------------------------------------------------
// Customer quotations (PT2)
// ---------------------------------------------------------------------------------------------

/** One path segment from a caller-supplied id: encoded, so `../` can never climb out of the route. */
const seg = (id: string): string => encodeURIComponent(id);

/**
 * Calls the API and parses the answer with `schema`. A refusal throws `ApiError` with the API's
 * status; a body that does not match the contract throws 502. The portal schemas are strict, so an
 * extra (internal) field fails the parse instead of reaching a page.
 */
async function call<T>(
  session: Pick<Session, 'accessToken'>,
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = { method: 'GET' },
): Promise<T> {
  const res = await authedFetch(session.accessToken, path, init);
  const body = await readBody(res);
  const label = `${init.method ?? 'GET'} ${path}`;
  if (!res.ok) throw new ApiError(res.status, `${label} failed with ${res.status}`, body);
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new ApiError(502, `${label} returned an invalid body`, parsed.error.issues);
  }
  return parsed.data;
}

/** `GET /v1/portal/display`: how the company writes numbers and dates. Any portal caller may read it. */
export function fetchPortalDisplay(session: Pick<Session, 'accessToken'>): Promise<PortalDisplay> {
  return call(session, '/v1/portal/display', PortalDisplaySchema);
}

/** `GET /v1/portal/quotations`: the customer's own quotations, customer-visible states only. */
export function listPortalQuotations(
  session: Pick<Session, 'accessToken'>,
): Promise<PortalQuotationListItem[]> {
  return call(session, '/v1/portal/quotations', z.array(PortalQuotationListItemSchema));
}

/** `GET /v1/portal/quotations/:id`. The API answers 404 for a foreign, draft or unknown id. */
export function getPortalQuotation(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<CustomerQuotationView> {
  // A body in a state the customer may not see is answered as "not found", never as a 502: an
  // error page would tell the customer that something exists behind the id.
  const NotVisible = z
    .looseObject({ status: z.string() })
    .refine((b) => !(CUSTOMER_VISIBLE_STATUSES as readonly string[]).includes(b.status));
  const VisibleView = z.unknown().transform((body, ctx) => {
    if (NotVisible.safeParse(body).success) {
      throw new ApiError(404, `GET /v1/portal/quotations/:id returned a non-visible status`);
    }
    const parsed = CustomerQuotationViewSchema.safeParse(body);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, code: 'custom' });
      return z.NEVER;
    }
    return parsed.data;
  });
  return call(session, `/v1/portal/quotations/${seg(id)}`, VisibleView);
}

/** `GET /v1/portal/quotations/:id/document`: a short-lived signed link to the frozen PDF. */
export function getPortalQuotationLink(
  session: Pick<Session, 'accessToken'>,
  id: string,
): Promise<SignedLinkDto> {
  return call(session, `/v1/portal/quotations/${seg(id)}/document`, SignedLinkDtoSchema);
}

const SIGNED_PATH = /^\/v1\/files\/[A-Za-z0-9._~-]+$/;

/**
 * Fetches the bytes behind a signed link. The link is a relative `/v1/files/<token>` path on the
 * API origin, and the portal has no public API URL (its CSP is `connect-src 'self'`), so the BFF
 * fetches it over the internal URL and the route streams it on. Anything else is refused unfetched.
 */
export async function openSignedFile(
  session: Pick<Session, 'accessToken'>,
  link: SignedLinkDto,
): Promise<Response> {
  if (!SIGNED_PATH.test(link.url)) {
    throw new ApiError(502, 'The API returned a download link in an unexpected form');
  }
  const res = await authedFetch(session.accessToken, link.url, { method: 'GET' });
  if (!res.ok) {
    throw new ApiError(res.status, `GET /v1/files failed with ${res.status}`, await readBody(res));
  }
  return res;
}

/**
 * Sends a customer decision. The key is required, so a missing one is a compile error: a retry
 * after a timeout must reuse it so the decision cannot apply twice. Any 2xx is success and its
 * body is not read; the page reloads the view afterwards.
 */
async function decide(
  session: Pick<Session, 'accessToken'>,
  path: string,
  body: AcceptQuotationBody | RejectQuotationBody,
  idempotencyKey: string,
): Promise<void> {
  const res = await authedFetch(session.accessToken, path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new ApiError(res.status, `POST ${path} failed with ${res.status}`, await readBody(res));
  }
}

export function acceptPortalQuotation(
  session: Pick<Session, 'accessToken'>,
  id: string,
  body: AcceptQuotationBody,
  idempotencyKey: string,
): Promise<void> {
  return decide(session, `/v1/portal/quotations/${seg(id)}/accept`, body, idempotencyKey);
}

export function rejectPortalQuotation(
  session: Pick<Session, 'accessToken'>,
  id: string,
  body: RejectQuotationBody,
  idempotencyKey: string,
): Promise<void> {
  return decide(session, `/v1/portal/quotations/${seg(id)}/reject`, body, idempotencyKey);
}
