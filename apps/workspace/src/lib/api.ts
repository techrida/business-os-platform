import 'server-only';

import { randomUUID } from 'node:crypto';

import { dropUnknownGrants, type MeResponse, MeResponseSchema } from '@bos/contracts';

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

/** Async so a bad path rejects the promise instead of throwing synchronously at the call site. */
async function authedFetch(
  accessToken: string,
  path: string,
  init?: RequestInit,
): Promise<Response> {
  const url = apiUrl(path);
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${accessToken}`);
  // A fresh id per call; a UUID fits the API's `^[A-Za-z0-9-]{8,64}$` correlation id rule.
  headers.set('x-request-id', randomUUID());
  // Responses are per user: never let Next's data cache keep or share them.
  return await fetch(url, { ...init, headers, cache: 'no-store' });
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
