import { cookies } from 'next/headers';

import {
  developmentAccounts,
  localDevelopmentRequest,
  switchDevelopmentAccount,
} from '@/dev/accounts.server';
import { LOGIN_COOKIE, LOGIN_COOKIE_MAX_AGE } from '@/lib/oidc';
import { checkLoginRateLimit } from '@/lib/rate-limit';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
const headers = { 'cache-control': 'no-store' };
export async function GET(req: Request): Promise<Response> {
  if (!localDevelopmentRequest(req)) return new Response(null, { status: 404 });
  try {
    return Response.json({ accounts: await developmentAccounts() }, { headers });
  } catch {
    return Response.json(
      { error: 'Development account service unavailable' },
      { status: 503, headers },
    );
  }
}
export async function POST(req: Request): Promise<Response> {
  if (!localDevelopmentRequest(req, true)) return new Response(null, { status: 404 });
  if (!(await checkLoginRateLimit(req)).allowed)
    return new Response(null, { status: 429, headers });
  try {
    const id = (await req.formData()).get('account');
    if (typeof id !== 'string' || !/^\d{1,30}$/.test(id))
      return new Response(null, { status: 400, headers });
    const { callback, binding } = await switchDevelopmentAccount(id);
    (await cookies()).set(LOGIN_COOKIE, binding, {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: LOGIN_COOKIE_MAX_AGE,
    });
    return new Response(null, {
      status: 303,
      headers: { ...headers, location: callback.toString() },
    });
  } catch {
    return new Response('Development sign-in failed. Reload and try again.', {
      status: 502,
      headers,
    });
  }
}
