import { cookies } from 'next/headers';

import { getEnv } from '@/lib/env';
import { endSessionUrl, SIGNED_OUT_COOKIE, SIGNED_OUT_COOKIE_MAX_AGE } from '@/lib/oidc';
import { clearSessionCookie, destroySession, peekSession, SESSION_COOKIE } from '@/lib/session';

// Copied from apps/workspace (dedupe later).
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

function redirectTo(location: string): Response {
  return new Response(null, { status: 303, headers: { location, 'cache-control': 'no-store' } });
}

// GET must never change state (a link, an <img> or a prefetch could log the user out), so it
// only shows a button that POSTs. The markup is static: nothing from the request is echoed.
const CONFIRM_PAGE = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Sign out - Customer portal</title>
  </head>
  <body>
    <main>
      <h1>Sign out?</h1>
      <form method="post" action="/auth/logout">
        <button type="submit">Sign out</button>
      </form>
      <p><a href="/">Cancel</a></p>
    </main>
  </body>
</html>
`;

export function GET(): Response {
  return new Response(CONFIRM_PAGE, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      // The page holds a state-changing button, so it must not be framable (clickjacking).
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'",
    },
  });
}

export async function POST(req: Request): Promise<Response> {
  const env = getEnv();
  const home = new URL('/', env.PORTAL_PUBLIC_URL).toString();

  // CSRF: the cookie is SameSite=Lax, which already blocks cross-site POSTs, and this is the
  // second wall. Browsers always send Origin on a POST, so a missing or different one is refused.
  if (req.headers.get('origin') !== new URL(env.PORTAL_PUBLIC_URL).origin) {
    return new Response('Forbidden', { status: 403 });
  }

  // CR-06: the cookie id, not getSession(). getSession() is null for an idle-expired record or
  // when Valkey is down, and it would also slide the TTL or refresh tokens mid-logout. Whatever
  // the local state, the ZITADEL session must end, or the next visit signs straight back in.
  const jar = await cookies();
  const id = jar.get(SESSION_COOKIE)?.value;
  let idTokenHint: string | undefined;
  if (id) {
    // Read the ID token before the record goes: ZITADEL needs it as id_token_hint to end its
    // own session. No record (expired, Valkey down) means no hint, and logout carries on.
    try {
      idTokenHint = (await peekSession(id))?.idToken;
    } catch (err) {
      // Only the error name, for the same reason as below.
      console.warn(
        JSON.stringify({
          event: 'auth.logout_read_failed',
          error: err instanceof Error ? err.name : 'unknown',
        }),
      );
    }
    try {
      await destroySession(id);
    } catch (err) {
      // Only the error name: ioredis errors carry the command arguments (the session key and
      // the stored record with its tokens). The record dies with its TTL anyway.
      console.warn(
        JSON.stringify({
          event: 'auth.logout_destroy_failed',
          error: err instanceof Error ? err.name : 'unknown',
        }),
      );
    }
  }
  // Cleared whatever happened above, so a stale cookie does not linger.
  await clearSessionCookie();

  // R2-001: without the hint ZITADEL keeps its session (its logout page only offers to end it), so the next
  // login here would sign straight back in. The marker makes that login ask for the credentials again.
  const markSignedOut = () =>
    jar.set(SIGNED_OUT_COOKIE, '1', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: SIGNED_OUT_COOKIE_MAX_AGE,
    });

  try {
    // Ends the ZITADEL session too; it needs the hint to end the user's session there.
    const url = await endSessionUrl(idTokenHint !== undefined ? { idTokenHint } : {});
    if (idTokenHint === undefined) markSignedOut();
    return redirectTo(url.toString());
  } catch {
    // The session cookie is already cleared, so a discovery failure must not strand the user.
    markSignedOut();
    return redirectTo(home);
  }
}
