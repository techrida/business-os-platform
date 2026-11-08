import { cookies } from 'next/headers';

import { ApiError, getMe } from '@/lib/api';
import { getEnv } from '@/lib/env';
import { completeLogin, LOGIN_COOKIE } from '@/lib/oidc';
import { createSession, setSessionCookie } from '@/lib/session';

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
    // Deny by default: only a customer user whose IdP org maps to a party (ADR 0027) gets a
    // portal session. Everyone else did sign in at ZITADEL, so they get a page that says where
    // to go, and its Sign out ends the ZITADEL session as /no-access does below.
    if (me.orgKind === 'staff') return redirectTo('/use-workspace');
    if (me.orgKind !== 'customer') return redirectTo('/not-available');
    if (!me.partyId) return redirectTo('/no-access');
    const id = await createSession({
      sub,
      orgId: me.organizationId,
      orgKind: 'customer',
      partyId: me.partyId,
      roles: me.roles,
      ...tokens,
    });
    await setSessionCookie(id);
    // returnTo went through safeReturnTo in /auth/login and was stored server-side with the state.
    return redirectTo(returnTo);
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
    const correlationId = crypto.randomUUID();
    console.error(JSON.stringify({ event: 'auth.callback_failed', correlationId }));
    return redirectTo('/auth/error?code=callback_failed');
  }
}
