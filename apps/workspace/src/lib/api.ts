import 'server-only';

import { randomUUID } from 'node:crypto';

import { dropUnknownGrants, type MeResponse, MeResponseSchema } from '@bos/contracts';
import { headers as requestHeaders } from 'next/headers';

import { getEnv } from './env';
import type { Session } from './session';

/**
 * Server-to-server calls from the BFF to the API. `server-only` makes any import from a Client
 * Component a build error, because these helpers attach the user's access token.
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
 * What a read that outlasted its deadline looks like to the callers: the same 503 `db_busy` refusal
 * the API sends when it is overloaded, so the existing "busy, try again" handling shows it. Only for
 * reads: a read can always be repeated.
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

/**
 * A write that outlasted its deadline may still have been committed, so it must not claim the safe
 * "nothing happened, retry" meaning of `db_busy`. A 504 with its own code reads as a gateway failure.
 */
function timeoutOfWrite(requestId: string): ApiError {
  return new ApiError(504, `API did not answer within ${API_TIMEOUT_MS / 1000} s`, {
    error: {
      code: 'api_timeout',
      message: 'The platform did not answer in time. The change may or may not have been saved.',
      correlationId: requestId,
    },
  });
}

/**
 * Only a call with no body, or a small in-memory one, gets the default deadline. A file moving in
 * either direction can take longer than 15 s on a slow link, and the deadline would cut it off.
 */
function getsDefaultDeadline(init: RequestInit | undefined): boolean {
  const body = init?.body;
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof URLSearchParams
  );
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
  // The deadline is for the wait until the API starts answering. It stops once the response headers
  // arrive, so a long body (a file download) is never cut off by it.
  const deadline =
    init?.signal === undefined && getsDefaultDeadline(init) ? new AbortController() : undefined;
  const timer =
    deadline === undefined
      ? undefined
      : setTimeout(() => {
          deadline.abort(new DOMException('The API did not answer in time.', 'TimeoutError'));
        }, API_TIMEOUT_MS);
  const signal = init?.signal ?? deadline?.signal;
  try {
    // Responses are per user: never let Next's data cache keep or share them.
    return await fetch(url, { ...init, headers, ...(signal ? { signal } : {}), cache: 'no-store' });
  } catch (err) {
    // Only our own deadline becomes a refusal; a caller's abort stays the caller's.
    if (deadline?.signal.aborted && err instanceof Error && err.name === 'TimeoutError') {
      const method = (init?.method ?? 'GET').toUpperCase();
      throw method === 'GET' || method === 'HEAD'
        ? timeoutAsBusy(requestId)
        : timeoutOfWrite(requestId);
    }
    throw err;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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

/** `GET /v1/me`, validated against the shared contract. Throws `ApiError` on any mismatch. */
export async function getMe(session: Pick<Session, 'accessToken'>): Promise<MeResponse> {
  const res = await authedFetch(session.accessToken, '/v1/me', { method: 'GET' });
  const body = await readBody(res);
  if (!res.ok) throw new ApiError(res.status, `GET /v1/me failed with ${res.status}`, body);
  // A newer API may send a permission or scope this build has no name for: drop those rows, warn, keep signing in.
  // A malformed row (null, {}, a non-string permission or scope) is kept, so the parse below fails with a 502.
  const { body: known, dropped } = dropUnknownGrants(body);
  if (dropped.length > 0) {
    console.warn(JSON.stringify({ event: 'me.unknown_grants_dropped', dropped }));
  }
  const parsed = MeResponseSchema.safeParse(known);
  if (!parsed.success) {
    // 502: the upstream answered, but not with the shape we agreed on.
    throw new ApiError(502, 'GET /v1/me returned an invalid body', parsed.error.issues);
  }
  return parsed.data;
}
