import { cookies } from 'next/headers';

import { ApiError, getMe } from '@/lib/api';
import { getEnv } from '@/lib/env';
import {
  completeLogin,
  LOGIN_COOKIE,
  SIGNED_IN_COOKIE,
  SIGNED_IN_COOKIE_MAX_AGE,
  SIGNED_OUT_COOKIE,
  StaleSignInError,
} from '@/lib/oidc';
import {
  createSession,
  destroySession,
  safeReturnTo,
  SESSION_COOKIE,
  setSessionCookie,
} from '@/lib/session';

// Copied from apps/workspace (dedupe later).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Redirects are built against the public URL, not req.url: behind Caddy the request reaches
// Next over plain http on an internal host, so req.url would point at the wrong origin.
function redirectTo(path: string): Response {
  return new Response(null, {
    status: 303,
    headers: {
      location: new URL(path, getEnv().PORTAL_PUBLIC_URL).toString(),
      'cache-control': 'no-store',
    },
  });
}

/** The vendor screens' root. A vendor never lands on the customer pages. */
const VENDOR_HOME = '/vendor';

/**
 * Where a vendor lands: the stored returnTo when it stays under /vendor, else /vendor. The value
 * went through safeReturnTo at login; it goes through again here so the prefix test below runs on
 * a normalised same-origin path. `/vendorx` and `/vendor-x` are not under /vendor.
 */
function vendorReturnTo(returnTo: string): string {
  const safe = safeReturnTo(returnTo);
  return safe === VENDOR_HOME || /^\/vendor[/?#]/.test(safe) ? safe : VENDOR_HOME;
}

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
    // ZITADEL now holds a session for this browser, even if the steps below send the person elsewhere: from here
    // on every login asks for the password (see SIGNED_IN_COOKIE).
    jar.set(SIGNED_IN_COOKIE, '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SIGNED_IN_COOKIE_MAX_AGE,
    });
    // Fixation and leftovers: the login succeeded at the identity provider, so the record this browser held
    // before (another user, or the same one again) goes now, before anything below can send the person
    // elsewhere (no access, wrong app) and leave that record alive.
    await destroyPreviousSession(jar.get(SESSION_COOKIE)?.value);
    // The API is the authority on org and roles, not the token claims.
    const me = await getMe({ accessToken: tokens.accessToken });
    // Deny by default: only a customer or vendor user whose IdP org maps to a party (ADR 0027)
    // gets a portal session. Everyone else did sign in at ZITADEL, so they get a page that says
    // where to go, and its Sign out ends the ZITADEL session as /no-access does below.
    if (me.orgKind === 'staff') return redirectTo('/use-workspace');
    if (me.orgKind !== 'customer' && me.orgKind !== 'vendor') return redirectTo('/not-available');
    if (!me.partyId) return redirectTo('/no-access');
    const id = await createSession({
      sub,
      orgId: me.organizationId,
      orgKind: me.orgKind,
      partyId: me.partyId,
      roles: me.roles,
      ...tokens,
    });
    await setSessionCookie(id);
    // Signed in again: SIGNED_IN_COOKIE carries on from here.
    if (jar.get(SIGNED_OUT_COOKIE)?.value) {
      jar.set(SIGNED_OUT_COOKIE, '', {
        httpOnly: true,
        secure: true,
        sameSite: 'lax',
        path: '/',
        maxAge: 0,
      });
    }
    // returnTo went through safeReturnTo in /auth/login and was stored server-side with the state.
    return redirectTo(me.orgKind === 'vendor' ? vendorReturnTo(returnTo) : returnTo);
  } catch (err) {
    // CR-02: the API answers 403 for a principal it will not serve (staff without a role, an
    // unknown org). That is a valid login with no access, not a failure: no session is created,
    // and /no-access renders without one. Its Sign out posts to /auth/logout, which ends the
    // ZITADEL session, so there is no silent re-login loop.
    if (err instanceof ApiError && err.status === 403) {
      return redirectTo('/no-access');
    }
    // Log a correlation id only. Error messages and stacks from the OIDC library can contain
    // the code, state or tokens, so nothing from the error itself goes to the log.
    // A refused stale sign-in gets its own event: a ZITADEL clock running behind ours would look like this too.
    const correlationId = crypto.randomUUID();
    const event = err instanceof StaleSignInError ? 'auth.stale_sign_in' : 'auth.callback_failed';
    console.error(JSON.stringify({ event, correlationId }));
    return redirectTo('/auth/error?code=callback_failed');
  }
}
