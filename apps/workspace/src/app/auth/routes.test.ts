import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The libs are mocked: these tests cover what the route handlers decide (what they pass on,
// where they redirect, what they log), not OIDC or Valkey, which U5a tests on their side.
const m = vi.hoisted(() => ({
  beginLogin: vi.fn(),
  completeLogin: vi.fn(),
  endSessionUrl: vi.fn(),
  getMe: vi.fn(),
  createSession: vi.fn(),
  setSessionCookie: vi.fn(),
  clearSessionCookie: vi.fn(),
  getSession: vi.fn(),
  destroySession: vi.fn(),
  safeReturnTo: vi.fn(),
}));

vi.mock('@/lib/oidc', () => ({
  beginLogin: m.beginLogin,
  completeLogin: m.completeLogin,
  endSessionUrl: m.endSessionUrl,
}));
vi.mock('@/lib/api', () => ({ getMe: m.getMe }));
vi.mock('@/lib/session', () => ({
  createSession: m.createSession,
  setSessionCookie: m.setSessionCookie,
  clearSessionCookie: m.clearSessionCookie,
  getSession: m.getSession,
  destroySession: m.destroySession,
  safeReturnTo: m.safeReturnTo,
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    WORKSPACE_PUBLIC_URL: 'https://app.localhost',
    OIDC_REDIRECT_URI: 'https://app.localhost/auth/callback',
  }),
}));

import { GET as callbackGET } from './callback/route';
import { GET as loginGET } from './login/route';
import { GET as logoutGET, POST as logoutPOST } from './logout/route';
import { GET as healthzGET } from '../healthz/route';

const ORIGIN = 'https://app.localhost';
const ACCESS = 'secret-access-token';
const REFRESH = 'secret-refresh-token';
const ID_TOKEN = 'secret-id-token';

beforeEach(() => {
  vi.resetAllMocks();
  // Same contract as the real one: a same-origin relative path survives, anything else is '/'.
  m.safeReturnTo.mockImplementation((raw: string | null | undefined) =>
    raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/',
  );
  m.beginLogin.mockResolvedValue(new URL('https://idp.example/oauth/v2/authorize?state=abc'));
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('GET /auth/login', () => {
  const call = (qs = '') => loginGET(new Request(`${ORIGIN}/auth/login${qs}`));

  it('redirects to the authorization URL with 303', async () => {
    const res = await call();
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://idp.example/oauth/v2/authorize?state=abc');
  });

  it('falls back to / for an unsafe returnTo', async () => {
    await call('?returnTo=' + encodeURIComponent('https://evil.example/steal'));
    expect(m.safeReturnTo).toHaveBeenCalledWith('https://evil.example/steal');
    expect(m.beginLogin).toHaveBeenCalledWith(expect.objectContaining({ returnTo: '/' }));
  });

  it('keeps a safe returnTo', async () => {
    await call('?returnTo=' + encodeURIComponent('/orders?id=1'));
    expect(m.beginLogin).toHaveBeenCalledWith(
      expect.objectContaining({ returnTo: '/orders?id=1' }),
    );
  });

  it('drops a prompt that is not on the allow-list', async () => {
    await call('?prompt=create');
    expect(m.beginLogin.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
  });

  it.each(['login', 'none', 'consent', 'select_account'])(
    'passes prompt=%s through',
    async (prompt) => {
      await call(`?prompt=${prompt}`);
      expect(m.beginLogin.mock.calls[0]?.[0]).toMatchObject({ prompt });
    },
  );

  it('passes a normal login_hint through', async () => {
    await call('?login_hint=' + encodeURIComponent('kuu@example.com'));
    expect(m.beginLogin.mock.calls[0]?.[0]).toMatchObject({ loginHint: 'kuu@example.com' });
  });

  it('drops an empty, overlong or control-character login_hint', async () => {
    for (const hint of ['', 'a'.repeat(201), 'a\nb', 'a\u0000b']) {
      m.beginLogin.mockClear();
      await call('?login_hint=' + encodeURIComponent(hint));
      expect(m.beginLogin.mock.calls[0]?.[0]).not.toHaveProperty('loginHint');
    }
  });

  it('accepts a login_hint of exactly 200 characters', async () => {
    const hint = 'a'.repeat(200);
    await call('?login_hint=' + hint);
    expect(m.beginLogin.mock.calls[0]?.[0]).toMatchObject({ loginHint: hint });
  });
});

describe('GET /auth/callback', () => {
  const call = (qs: string) => callbackGET(new Request(`http://0.0.0.0:3000/auth/callback${qs}`));

  const tokens = {
    accessToken: ACCESS,
    refreshToken: REFRESH,
    idToken: ID_TOKEN,
    accessExp: 1_900_000_000,
  };

  it('builds the session from /v1/me plus tokens, sets the cookie and redirects with 303', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-1', returnTo: '/orders' });
    m.getMe.mockResolvedValue({ organizationId: 'org-1', orgKind: 'staff', roles: ['admin'] });
    m.createSession.mockResolvedValue('sid-1');

    const res = await call('?code=c&state=s');

    expect(m.getMe).toHaveBeenCalledWith({ accessToken: ACCESS });
    expect(m.createSession).toHaveBeenCalledWith({
      sub: 'user-1',
      orgId: 'org-1',
      orgKind: 'staff',
      roles: ['admin'],
      ...tokens,
    });
    expect(m.setSessionCookie).toHaveBeenCalledWith('sid-1');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.localhost/orders');
  });

  it('hands completeLogin the registered redirect URI with only the query of the request', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/' });
    m.getMe.mockResolvedValue({ organizationId: 'o', orgKind: 'staff', roles: [] });
    m.createSession.mockResolvedValue('sid');

    await call('?code=c&state=s');

    const url = m.completeLogin.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe('https://app.localhost/auth/callback');
    expect(url.search).toBe('?code=c&state=s');
  });

  it('redirects an IdP error to idp_error without touching the token exchange', async () => {
    const res = await call('?error=access_denied&error_description=nope');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.localhost/auth/error?code=idp_error');
    expect(m.completeLogin).not.toHaveBeenCalled();
    expect(m.setSessionCookie).not.toHaveBeenCalled();
  });

  it('redirects to callback_failed and logs only a correlation id, never a token', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    // The failure happens after the code exchange, so the error text and the session input
    // both carry real token values: the worst case for a leak.
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/' });
    m.getMe.mockRejectedValue(
      new Error(`api failed for Bearer ${ACCESS} refresh=${REFRESH} id=${ID_TOKEN} code=abc`),
    );

    const res = await call('?code=abc&state=s');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'https://app.localhost/auth/error?code=callback_failed',
    );
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.setSessionCookie).not.toHaveBeenCalled();

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/correlationId/);
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, 'code=abc']) {
      expect(logged.join('\n')).not.toContain(secret);
    }
  });

  it('also fails closed when the state is missing or already used', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.completeLogin.mockRejectedValue(new Error('state not found'));
    const res = await call('?code=c&state=used');
    expect(res.headers.get('location')).toBe(
      'https://app.localhost/auth/error?code=callback_failed',
    );
  });
});

describe('/auth/logout', () => {
  const post = (headers: Record<string, string> = {}) =>
    logoutPOST(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers }));

  const session = { id: 'sid-1', idToken: ID_TOKEN };

  it('GET shows a confirm form and changes no state', async () => {
    const res = logoutGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<form method="post" action="/auth/logout">');
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).not.toHaveBeenCalled();
  });

  it('refuses a POST without an Origin header with 403 and changes nothing', async () => {
    m.getSession.mockResolvedValue(session);
    const res = await post();
    expect(res.status).toBe(403);
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).not.toHaveBeenCalled();
  });

  it('refuses a POST from another origin with 403 and changes nothing', async () => {
    m.getSession.mockResolvedValue(session);
    const res = await post({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).not.toHaveBeenCalled();
  });

  it('destroys the session, clears the cookie and redirects to end_session with the id token hint', async () => {
    m.getSession.mockResolvedValue(session);
    m.endSessionUrl.mockResolvedValue(new URL('https://idp.example/oidc/v1/end_session?x=1'));

    const res = await post({ origin: ORIGIN });

    expect(m.destroySession).toHaveBeenCalledWith('sid-1');
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(m.endSessionUrl).toHaveBeenCalledWith({ idTokenHint: ID_TOKEN });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://idp.example/oidc/v1/end_session?x=1');
  });

  it('still clears the cookie and goes home when there is no session', async () => {
    m.getSession.mockResolvedValue(null);
    const res = await post({ origin: ORIGIN });
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://app.localhost/');
  });

  it('goes home when ZITADEL discovery fails, after the local session is already gone', async () => {
    m.getSession.mockResolvedValue(session);
    m.endSessionUrl.mockRejectedValue(new Error('discovery down'));
    const res = await post({ origin: ORIGIN });
    expect(m.destroySession).toHaveBeenCalledWith('sid-1');
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe('https://app.localhost/');
  });
});

describe('GET /healthz', () => {
  it('returns { ok: true } and touches no lib', async () => {
    const res = healthzGET();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    for (const fn of Object.values(m)) expect(fn).not.toHaveBeenCalled();
  });
});
