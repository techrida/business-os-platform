import { getEnv } from '@/lib/env';
import { endSessionUrl } from '@/lib/oidc';
import { clearSessionCookie, destroySession, getSession } from '@/lib/session';

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
    <title>Sign out - Business OS</title>
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
  const home = new URL('/', env.WORKSPACE_PUBLIC_URL).toString();

  // CSRF: the cookie is SameSite=Lax, which already blocks cross-site POSTs, and this is the
  // second wall. Browsers always send Origin on a POST, so a missing or different one is refused.
  if (req.headers.get('origin') !== new URL(env.WORKSPACE_PUBLIC_URL).origin) {
    return new Response('Forbidden', { status: 403 });
  }

  const session = await getSession();
  if (session) {
    await destroySession(session.id);
  }
  // Cleared even without a live session, so a stale cookie does not linger.
  await clearSessionCookie();

  if (!session) {
    return redirectTo(home);
  }

  try {
    // Ends the ZITADEL session too; id_token_hint lets it skip its own confirmation screen.
    const url = await endSessionUrl(
      session.idToken === undefined ? {} : { idTokenHint: session.idToken },
    );
    return redirectTo(url.toString());
  } catch {
    // The local session is already gone, so a discovery failure must not strand the user.
    return redirectTo(home);
  }
}
