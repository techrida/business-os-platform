import 'server-only';

import { ErrorBodySchema } from '@bos/contracts';
import { redirect } from 'next/navigation';

import { ApiError } from './api';
import { dbBusyOf } from './db-busy';
import { failureOf } from './api-kernel';
import { getEnv } from './env';
import type { FailureContext } from './kernel-ui';
import { getSession, type GetSessionOptions, type Session } from './session';
import { SessionUnavailableError, sessionUnavailableResponse } from './session-unavailable';

/**
 * Shared plumbing for the workspace BFF: page guards and Route Handler helpers. Server-only.
 * Serves the NFR "no token ever reaches the browser": pages and handlers get the session here, call
 * the API with it, and hand the browser only the parsed result.
 */

/**
 * For pages and server actions. A layout cannot see the URL, so each page names its own path and
 * an unauthenticated user comes back to it after signing in. `redirect` throws, so the caller
 * never gets a null session. Store outages propagate to the root retry notice.
 */
export async function requireStaffSession(returnTo: string): Promise<Session> {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(returnTo)}`);
  if (session.orgKind !== 'staff') redirect('/staff-only');
  return session;
}

const NO_STORE = { 'cache-control': 'no-store' } as const;

export function jsonResponse(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: NO_STORE });
}

/**
 * For Route Handlers: the session, or a 401/403/503 JSON response the handler returns as is. A handler
 * never redirects, because `fetch` from the browser would follow the redirect into the login HTML.
 * Background polls pass `{ slide: false }` so they do not keep the session alive.
 */
export async function routeSession(options?: GetSessionOptions): Promise<Session | Response> {
  let session: Session | null;
  try {
    session = await getSession(options);
  } catch (err) {
    if (err instanceof SessionUnavailableError) return sessionUnavailableResponse();
    throw err;
  }
  if (!session) return jsonResponse({ error: { message: 'Sign in to continue.' } }, 401);
  if (session.orgKind !== 'staff') {
    return jsonResponse({ error: { message: 'This area is for staff only.' } }, 403);
  }
  return session;
}

/**
 * Route Handlers do not get the origin check Next runs for Server Actions, so a state-changing
 * handler calls this. The `__Host-` cookie is `SameSite=Lax`, which already stops cross-site
 * POSTs; this is the second wall.
 */
export function isSameOrigin(req: Request): boolean {
  const origin = req.headers.get('origin');
  return origin !== null && origin === new URL(getEnv().WORKSPACE_PUBLIC_URL).origin;
}

export function forbiddenOrigin(): Response {
  return jsonResponse({ error: { message: 'This request did not come from the workspace.' } }, 403);
}

/** Maps a thrown API failure to a JSON response the browser code can show as is. */
export function errorResponse(err: unknown, context: FailureContext = 'generic'): Response {
  const busy = dbBusyOf(err);
  if (busy !== null) {
    // The API rolled back and says it is safe to retry (503 db_busy + Retry-After). That is not a gateway fault:
    // keep the 503 and the wait, so the browser code can retry after it instead of reading a 502 as a crash.
    return Response.json(
      { error: { message: 'Busy, please try again.', reload: false } },
      { status: 503, headers: { ...NO_STORE, 'retry-after': String(busy.retryAfterSeconds) } },
    );
  }
  const failure = failureOf(err, context);
  // Pass client errors through; anything else (API down, 5xx) is a gateway problem from the
  // browser's point of view.
  const status = failure.status >= 400 && failure.status < 500 ? failure.status : 502;
  return jsonResponse({ error: { message: failure.message, reload: failure.reload } }, status);
}

/** The API's code for "this decision needs a recent sign-in" (K7, Founder approvals). */
export const STEP_UP_REQUIRED = 'step_up_required';

/** True only for the API's 401 whose error body carries `code: 'step_up_required'`. */
export function isStepUpRequired(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 401) return false;
  const parsed = ErrorBodySchema.safeParse(err.body);
  return parsed.success && parsed.data.error.code === STEP_UP_REQUIRED;
}

/**
 * The normal login route with `prompt=login` and `max_age=0`, so ZITADEL asks for the credentials
 * again even with a live ZITADEL session. `max_age` also obliges the IdP (OIDC Core 3.1.2.1) to
 * report `auth_time`, which the API needs fresh. Going through /auth/login keeps
 * every login protection: the `__Host-` binding cookie, server-side state and `safeReturnTo`. The
 * callback then creates a new session holding the new tokens.
 */
export function stepUpLoginUrl(returnTo: string): string {
  return `/auth/login?prompt=login&max_age=0&returnTo=${encodeURIComponent(returnTo)}`;
}

/** For server actions and pages: `redirect` throws, so nothing after this runs. */
export function redirectToStepUp(returnTo: string): never {
  redirect(stepUpLoginUrl(returnTo));
}

export { dbBusyOf };
