import { cookies } from 'next/headers';

import { ApiError, getMe } from '@/lib/api';
import { getEnv } from '@/lib/env';
import { completeLogin, LOGIN_COOKIE, LoginStateExpiredError, SIGNED_OUT_COOKIE } from '@/lib/oidc';
import { createSession, destroySession, SESSION_COOKIE, setSessionCookie } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Redirects are built against the public URL, not req.url: behind Caddy the request reaches
// Next over plain http on an internal host, so req.url would point at the wrong origin.
function redirectTo(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(path, getEnv().WORKSPACE_PUBLIC_URL).toString(),
      'cache-control': 'no-store',
    },
  });
}

// A short-lived browser marker bounds automatic recovery to one fresh login attempt.
const RECOVERY_COOKIE = '__Host-bos_login_recovery';
const RECOVERY_COOKIE_OPTIONS = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax' as const,
  path: '/',
};

/** Best effort: a failed delete must not block the sign-in. The old record dies with its TTL. */
async function destroyPreviousSession(previousId: string | undefined): Promise<void> {
  if (!previousId) return;
  try {
    await destroySession(previousId);
  } catch (err) {
    // Only the error name: ioredis errors carry the command arguments.
    console.warn(
      JSON.stringify({
        event: 'auth.previous_session_destroy_failed',
        error: err instanceof Error ? err.name : 'unknown',
      }),
    );
  }
}

export async function GET(req: Request): Promise<Response> {
  const incoming = new URL(req.url);

  // CR-01: read the login binding cookie, then expire it whatever happens next, so each one
  // backs a single attempt. Same attributes as /auth/login set it with: browsers ignore a
  // `__Host-` Set-Cookie without Secure and Path=/, which would leave the old cookie in place.
  const jar = await cookies();
  const binding = jar.get(LOGIN_COOKIE)?.value;
  jar.set(LOGIN_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });

  // ZITADEL reports the user cancelling or a failed login as ?error=...&error_description=...
  // The description is untrusted text, so it is neither logged nor forwarded.
  if (incoming.searchParams.has('error')) {
    return redirectTo('/auth/error?code=idp_error');
  }

  try {
    // openid-client derives redirect_uri from the URL it is given and ZITADEL compares it with
    // the registered one. req.url has the internal scheme and host (see above), so keep only the
    // query (code, state) and graft it onto the configured redirect URI.
    const callbackUrl = new URL(getEnv().OIDC_REDIRECT_URI);
    callbackUrl.search = incoming.search;

    // Throws before any token request when the binding cookie is missing or foreign.
    const { tokens, sub, returnTo } = await completeLogin(callbackUrl, binding);
    // The API is the authority on org and roles, not the token claims.
    const me = await getMe({ accessToken: tokens.accessToken });
    // Fixation and leftovers: the record this browser held before (a different user, or the same
    // one signing in again) is deleted before the new one exists, so it cannot outlive the sign-in.
    await destroyPreviousSession(jar.get(SESSION_COOKIE)?.value);
    const id = await createSession({
      sub,
      orgId: me.organizationId,
      orgKind: me.orgKind,
      roles: me.roles,
      ...tokens,
    });
    await setSessionCookie(id);
    jar.set(RECOVERY_COOKIE, '', { ...RECOVERY_COOKIE_OPTIONS, maxAge: 0 });
    // Signed in again: the next login may reuse the ZITADEL session as usual.
    if (jar.get(SIGNED_OUT_COOKIE)?.value) {
      jar.set(SIGNED_OUT_COOKIE, '', { ...RECOVERY_COOKIE_OPTIONS, maxAge: 0 });
    }
    // returnTo went through safeReturnTo in /auth/login and was stored server-side with the state.
    return redirectTo(returnTo);
  } catch (err) {
    // The identity provider may have completed MFA after our ten-minute transaction expired.
    // Start a fresh, browser-bound flow; never accept the stale code or bypass its checks.
    // ZITADEL can reuse its authenticated session, so this normally needs no user input.
    if (err instanceof LoginStateExpiredError && !jar.get(RECOVERY_COOKIE)?.value) {
      jar.set(RECOVERY_COOKIE, '1', { ...RECOVERY_COOKIE_OPTIONS, maxAge: 600 });
      return redirectTo('/auth/login');
    }
    // CR-02: the API answers 403 for staff without a project role. That is a valid login with
    // no access, not a failure: no session is created, and /no-access renders without one. Its
    // Sign out posts to /auth/logout, which ends the ZITADEL session, so there is no silent
    // re-login loop.
    if (err instanceof ApiError && err.status === 403) {
      return redirectTo('/no-access');
    }
    // Log a correlation id only. Error messages and stacks from the OIDC library can contain
    // the code, state or tokens, so nothing from the error itself goes to the log.
    const correlationId = crypto.randomUUID();
    console.error(JSON.stringify({ event: 'auth.callback_failed', correlationId }));
    return redirectTo('/auth/error?code=callback_failed');
  }
}
