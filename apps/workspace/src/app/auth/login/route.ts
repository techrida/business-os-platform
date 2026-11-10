import { cookies } from 'next/headers';

import { beginLogin, LOGIN_COOKIE, LOGIN_COOKIE_MAX_AGE } from '@/lib/oidc';
import { checkLoginRateLimit } from '@/lib/rate-limit';
import { safeReturnTo } from '@/lib/session';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// These values come from the query string, so they are attacker-controlled. Anything that does
// not pass is dropped rather than rejected: the user still gets the normal login screen.
const ALLOWED_PROMPTS = ['login', 'none', 'consent', 'select_account'] as const;
type Prompt = (typeof ALLOWED_PROMPTS)[number];

// 1 to 200 characters, none of them control characters (newlines, NUL, DEL). Non-ASCII is fine
// because real e-mail addresses contain it.
const LOGIN_HINT = /^[^\p{Cc}]{1,200}$/u;

function parsePrompt(raw: string | null): Prompt | undefined {
  return ALLOWED_PROMPTS.find((p) => p === raw);
}

function parseLoginHint(raw: string | null): string | undefined {
  return raw !== null && LOGIN_HINT.test(raw) ? raw : undefined;
}

export async function GET(req: Request): Promise<Response> {
  // CR-03: before beginLogin, so a blocked request writes no OIDC state to Valkey and no cookie.
  const limit = await checkLoginRateLimit(req);
  if (!limit.allowed) {
    // Without this a 429 leaves no server trace. Only the delay: no client IP, no session id.
    console.warn(
      JSON.stringify({ event: 'auth.login_rate_limited', retryAfter: limit.retryAfter }),
    );
    return new Response('Too many sign-in attempts. Try again shortly.', {
      status: 429,
      headers: {
        'retry-after': String(limit.retryAfter),
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
      },
    });
  }

  const params = new URL(req.url).searchParams;
  const loginHint = parseLoginHint(params.get('login_hint'));
  const prompt = parsePrompt(params.get('prompt'));
  // Spread instead of `key: undefined`: the tsconfig has exactOptionalPropertyTypes on.
  const { url, binding } = await beginLogin({
    ...(loginHint !== undefined && { loginHint }),
    ...(prompt !== undefined && { prompt }),
    // Open-redirect guard: only a same-origin relative path survives, everything else is '/'.
    returnTo: safeReturnTo(params.get('returnTo')),
  });
  // CR-01: the callback only completes in the browser holding this cookie. SameSite=Lax still
  // sends it on the top-level GET redirect back from ZITADEL.
  (await cookies()).set(LOGIN_COOKIE, binding, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: LOGIN_COOKIE_MAX_AGE,
  });
  // 303 so the browser always follows with GET, and nothing caches the one-time state URL.
  return new Response(null, {
    status: 303,
    headers: { location: url.toString(), 'cache-control': 'no-store' },
  });
}
