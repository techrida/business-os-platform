import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
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
  peekSession: vi.fn(),
  destroySession: vi.fn(),
  safeReturnTo: vi.fn(),
  getOidcRedis: vi.fn(),
  cookies: vi.fn(),
  cookieSet: vi.fn(),
}));

// Stands in for the real ApiError (api.ts imports server-only), so `instanceof` still works.
const { ApiError } = vi.hoisted(() => ({
  ApiError: class ApiError extends Error {
    readonly status: number;
    constructor(status: number, message: string) {
      super(message);
      this.name = 'ApiError';
      this.status = status;
    }
  },
}));

/** The request's cookies, as `cookies().get()` sees them. Reset per test. */
let requestCookies = new Map<string, string>();

vi.mock('@/lib/oidc', () => ({
  // Pinned to the literal here and in oidc.test.ts, so a renamed constant fails one of them.
  LOGIN_COOKIE: '__Host-bos_portal_login',
  LOGIN_COOKIE_MAX_AGE: 600,
  SIGNED_OUT_COOKIE: '__Host-bos_portal_signed_out',
  SIGNED_OUT_COOKIE_MAX_AGE: 2_592_000,
  beginLogin: m.beginLogin,
  completeLogin: m.completeLogin,
  endSessionUrl: m.endSessionUrl,
  // The login rate limiter (CR-03) runs for real against an in-memory Valkey.
  getOidcRedis: m.getOidcRedis,
}));
vi.mock('next/headers', () => ({ cookies: m.cookies }));
vi.mock('@/lib/api', () => ({ ApiError, getMe: m.getMe }));
vi.mock('@/lib/session', () => ({
  // Pinned to the literal, like LOGIN_COOKIE: logout reads this cookie itself.
  SESSION_COOKIE: '__Host-bos_portal_session',
  createSession: m.createSession,
  setSessionCookie: m.setSessionCookie,
  clearSessionCookie: m.clearSessionCookie,
  getSession: m.getSession,
  peekSession: m.peekSession,
  destroySession: m.destroySession,
  safeReturnTo: m.safeReturnTo,
}));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    PORTAL_PUBLIC_URL: 'https://portal.localhost',
    OIDC_REDIRECT_URI: 'https://portal.localhost/auth/callback',
  }),
}));

import { GET as callbackGET } from './callback/route';
import { GET as loginGET } from './login/route';
import { GET as logoutGET, POST as logoutPOST } from './logout/route';
import { GET as healthzGET } from '../healthz/route';

const ORIGIN = 'https://portal.localhost';
const ACCESS = 'secret-access-token';
const REFRESH = 'secret-refresh-token';
const ID_TOKEN = 'secret-id-token';
const LOGIN_COOKIE = '__Host-bos_portal_login';
const SESSION_COOKIE = '__Host-bos_portal_session';
const SIGNED_OUT_COOKIE = '__Host-bos_portal_signed_out';
/** The signed-out marker writes, as [value, maxAge] pairs. */
const signedOutWrites = (): [unknown, number | undefined][] =>
  (m.cookieSet.mock.calls as unknown[][])
    .filter((c) => c[0] === SIGNED_OUT_COOKIE)
    .map((c) => [c[1], (c[2] as { maxAge?: number }).maxAge]);
const SESSION_ID = 's'.repeat(43);
const BINDING = 'b'.repeat(43);
const LOGIN_COOKIE_ATTRS = { httpOnly: true, secure: true, sameSite: 'lax', path: '/' };
const PARTY_ID = '00000000-0000-4000-8000-0000000000aa';
/** What /v1/me answers for a portal user: a customer org that maps to a party (ADR 0027). */
const CUSTOMER_ME = { organizationId: 'org-1', orgKind: 'customer', partyId: PARTY_ID, roles: [] };

// Loaded through require, as in session.test.ts: ioredis-mock has no reachable types.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;
const redis = new RedisMock();

beforeEach(async () => {
  vi.resetAllMocks();
  await redis.flushall(); // every login test shares one client IP bucket
  m.getOidcRedis.mockReturnValue(redis);
  // Same contract as the real one: a same-origin relative path survives, anything else is '/'.
  m.safeReturnTo.mockImplementation((raw: string | null | undefined) =>
    raw && raw.startsWith('/') && !raw.startsWith('//') && !raw.includes('\\') ? raw : '/',
  );
  m.beginLogin.mockResolvedValue({
    url: new URL('https://idp.example/oauth/v2/authorize?state=abc'),
    binding: BINDING,
  });
  requestCookies = new Map();
  m.cookies.mockResolvedValue({
    get: (name: string) => {
      const value = requestCookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    set: m.cookieSet,
  });
});

/** Every cookie name the handler wrote to the response, directly or through the session lib. */
function cookiesWritten(): string[] {
  return [
    ...m.cookieSet.mock.calls.map((c) => String(c[0])),
    ...(m.setSessionCookie.mock.calls.length > 0 ? ['__Host-bos_portal_session'] : []),
  ];
}

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

  // CR-01: the callback only completes in the browser that holds this cookie.
  it('sets the __Host-bos_portal_login binding cookie: HttpOnly, Secure, SameSite=Lax, Path=/, 10 minutes', async () => {
    const res = await call();
    expect(res.status).toBe(303);
    expect(m.cookieSet).toHaveBeenCalledTimes(1);
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, BINDING, {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 600,
    });
    expect(res.headers.get('cache-control')).toBe('no-store');
  });

  it('asks for prompt=login while the signed-out marker is set, whatever prompt the link carried', async () => {
    requestCookies.set(SIGNED_OUT_COOKIE, '1');
    await call('?prompt=none');
    expect(m.beginLogin.mock.calls[0]?.[0]).toMatchObject({ prompt: 'login' });
    await call();
    expect(m.beginLogin.mock.calls[1]?.[0]).toMatchObject({ prompt: 'login' });
  });

  it('sends no prompt of its own without the marker', async () => {
    await call();
    expect(m.beginLogin.mock.calls[0]?.[0]).not.toHaveProperty('prompt');
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

  // CR-03: each login stores OIDC state in Valkey, which runs noeviction. Unlimited logins fill
  // it and then every session write fails.
  describe('rate limit', () => {
    // Fake only Date (ioredis-mock needs real timers), so the window TTL cannot tick to 59.
    beforeEach(() => {
      vi.useFakeTimers({ toFake: ['Date'] });
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const from = (ip: string) =>
      loginGET(
        new Request(`${ORIGIN}/auth/login`, { headers: { 'x-forwarded-for': `${ip}, 10.0.0.2` } }),
      );

    it('answers the 21st login from one IP in a minute with 429 and Retry-After, before any OIDC state or cookie', async () => {
      for (let i = 0; i < 20; i++) expect((await from('203.0.113.7')).status).toBe(303);
      m.beginLogin.mockClear();
      m.cookieSet.mockClear();

      const res = await from('203.0.113.7');

      expect(res.status).toBe(429);
      expect(res.headers.get('retry-after')).toBe('60');
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(m.beginLogin).not.toHaveBeenCalled();
      expect(cookiesWritten()).toEqual([]);
    });

    it('still lets another IP sign in', async () => {
      for (let i = 0; i < 21; i++) await from('203.0.113.7');
      expect((await from('198.51.100.1')).status).toBe(303);
    });
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
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid-1');
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(m.getMe).toHaveBeenCalledWith({ accessToken: ACCESS });
    expect(m.createSession).toHaveBeenCalledWith({
      sub: 'user-1',
      orgId: 'org-1',
      orgKind: 'customer',
      partyId: PARTY_ID,
      roles: [],
      ...tokens,
    });
    expect(m.setSessionCookie).toHaveBeenCalledWith('sid-1');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://portal.localhost/orders');
  });

  it('deletes the session record this browser already held before it creates the new one', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-2', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid-2');
    requestCookies.set(LOGIN_COOKIE, BINDING);
    requestCookies.set(SESSION_COOKIE, SESSION_ID);

    await call('?code=c&state=s');

    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.destroySession.mock.invocationCallOrder[0]).toBeLessThan(
      m.createSession.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it('deletes the previous record even when this sign-in is turned away (staff on the portal)', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-2', returnTo: '/' });
    m.getMe.mockResolvedValue({ ...CUSTOMER_ME, orgKind: 'staff', partyId: null });
    requestCookies.set(LOGIN_COOKIE, BINDING);
    requestCookies.set(SESSION_COOKIE, SESSION_ID);

    const res = await call('?code=c&state=s');

    expect(res.headers.get('location')).toBe('https://portal.localhost/use-workspace');
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
  });

  it('does not delete anything when the browser held no session, and keeps the old one when sign-in fails', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-2', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid-2');
    requestCookies.set(LOGIN_COOKIE, BINDING);
    await call('?code=c&state=s');
    expect(m.destroySession).not.toHaveBeenCalled();

    m.completeLogin.mockRejectedValue(new Error('bad code'));
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    requestCookies.set(LOGIN_COOKIE, BINDING);
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    await call('?code=c&state=s');
    expect(m.destroySession).not.toHaveBeenCalled();
  });

  it('still signs in when the old record cannot be deleted, and logs only the error name', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-2', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid-2');
    m.destroySession.mockRejectedValue(
      Object.assign(new Error(`del ws:sess:secret-key ${ACCESS}`), { name: 'ReplyError' }),
    );
    requestCookies.set(LOGIN_COOKIE, BINDING);
    requestCookies.set(SESSION_COOKIE, SESSION_ID);

    const res = await call('?code=c&state=s');

    expect(m.setSessionCookie).toHaveBeenCalledWith('sid-2');
    expect(res.status).toBe(303);
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain('ReplyError');
    expect(logged).not.toContain('secret-key');
    expect(logged).not.toContain(ACCESS);
  });

  it('clears the signed-out marker once the person has signed in again', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'user-1', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid-1');
    requestCookies.set(LOGIN_COOKIE, BINDING);
    requestCookies.set(SIGNED_OUT_COOKIE, '1');

    await call('?code=c&state=s');

    expect(m.cookieSet).toHaveBeenCalledWith(SIGNED_OUT_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
  });

  it('keeps the signed-out marker when the login fails', async () => {
    requestCookies.set(SIGNED_OUT_COOKIE, '1');
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.completeLogin.mockRejectedValue(new Error('bad code'));
    await call('?code=c&state=s');
    expect(signedOutWrites()).toEqual([]);
  });

  it('hands completeLogin the registered redirect URI with only the query of the request', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid');
    requestCookies.set(LOGIN_COOKIE, BINDING);

    await call('?code=c&state=s');

    const url = m.completeLogin.mock.calls[0]?.[0] as URL;
    expect(url.origin + url.pathname).toBe('https://portal.localhost/auth/callback');
    expect(url.search).toBe('?code=c&state=s');
    expect(m.completeLogin.mock.calls[0]?.[1]).toBe(BINDING);
  });

  it('passes the login cookie to completeLogin, signs in and clears the cookie', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/orders' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid');
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(m.completeLogin).toHaveBeenCalledWith(expect.any(URL), BINDING);
    expect(m.setSessionCookie).toHaveBeenCalledWith('sid');
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://portal.localhost/orders');
  });

  it('without the login cookie: 303 to callback_failed, no session cookie, login cookie cleared', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    // Same contract as the real completeLogin: no binding, no token exchange, it throws.
    m.completeLogin.mockImplementation((_url: URL, binding: string | undefined) =>
      binding === BINDING
        ? Promise.resolve({ tokens, sub: 'attacker', returnTo: '/' })
        : Promise.reject(new Error('oidc: login is not bound to this browser')),
    );
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid');

    const res = await call('?code=attacker-code&state=attacker-state');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(
      'https://portal.localhost/auth/error?code=callback_failed',
    );
    expect(m.completeLogin).toHaveBeenCalledWith(expect.any(URL), undefined);
    expect(m.createSession).not.toHaveBeenCalled();
    expect(cookiesWritten()).not.toContain('__Host-bos_portal_session');
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
  });

  it('redirects an IdP error to idp_error without touching the token exchange', async () => {
    const res = await call('?error=access_denied&error_description=nope');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://portal.localhost/auth/error?code=idp_error');
    expect(m.completeLogin).not.toHaveBeenCalled();
    expect(m.setSessionCookie).not.toHaveBeenCalled();
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
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
      'https://portal.localhost/auth/error?code=callback_failed',
    );
    expect(m.createSession).not.toHaveBeenCalled();
    expect(m.setSessionCookie).not.toHaveBeenCalled();
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toMatch(/correlationId/);
    for (const secret of [ACCESS, REFRESH, ID_TOKEN, 'code=abc']) {
      expect(logged.join('\n')).not.toContain(secret);
    }
  });

  // CR-02: the API refuses staff without a project role with 403. That is not a broken login,
  // so it lands on /no-access (which renders without a session) instead of callback_failed.
  it('sends a 403 from /v1/me to /no-access, with no session and the login cookie cleared', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/orders' });
    m.getMe.mockRejectedValue(new ApiError(403, 'GET /v1/me failed with 403'));
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe('https://portal.localhost/no-access');
    expect(m.createSession).not.toHaveBeenCalled();
    expect(cookiesWritten()).not.toContain('__Host-bos_portal_session');
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
  });

  it('lands a customer on / when returnTo is /', async () => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/' });
    m.getMe.mockResolvedValue(CUSTOMER_ME);
    m.createSession.mockResolvedValue('sid');
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(m.createSession).toHaveBeenCalledWith(expect.objectContaining({ orgKind: 'customer' }));
    expect(res.headers.get('location')).toBe('https://portal.localhost/');
  });

  // P4: a vendor user whose IdP org maps to a party gets a vendor session and the vendor screens.
  // A returnTo outside /vendor (the customer landing page, or a look-alike prefix) is dropped.
  it.each([
    ['/', '/vendor'],
    ['/quotations', '/vendor'],
    ['/vendorx', '/vendor'],
    ['/vendor-evil/x', '/vendor'],
    ['/vendor', '/vendor'],
    ['/vendor/bills?x=1', '/vendor/bills?x=1'],
    ['/vendor?tab=po', '/vendor?tab=po'],
  ])('signs a vendor in with a vendor session; returnTo %s lands on %s', async (returnTo, page) => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'vendor-user', returnTo });
    m.getMe.mockResolvedValue({ ...CUSTOMER_ME, orgKind: 'vendor', roles: ['vendor_admin'] });
    m.createSession.mockResolvedValue('sid-v');
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(m.createSession).toHaveBeenCalledWith({
      sub: 'vendor-user',
      orgId: 'org-1',
      orgKind: 'vendor',
      partyId: PARTY_ID,
      roles: ['vendor_admin'],
      ...tokens,
    });
    expect(m.setSessionCookie).toHaveBeenCalledWith('sid-v');
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://portal.localhost${page}`);
  });

  // Only customer and vendor users with a party may hold a portal session. Everyone else signed
  // in fine at ZITADEL, so they get a page that says where to go, never a session.
  it.each([
    [
      'a staff principal',
      { orgKind: 'staff', partyId: null, roles: ['founder'] },
      '/use-workspace',
    ],
    ['a staff principal even with a party', { orgKind: 'staff' }, '/use-workspace'],
    ['a vendor with no party', { orgKind: 'vendor', partyId: null }, '/no-access'],
    [
      'a vendor when /v1/me has no partyId',
      { orgKind: 'vendor', partyId: undefined },
      '/no-access',
    ],
    ['a customer with no party', { partyId: null }, '/no-access'],
    ['a customer when /v1/me has no partyId', { partyId: undefined }, '/no-access'],
  ])('turns away %s: 303 to its page, no session, login cookie cleared', async (_l, me, page) => {
    m.completeLogin.mockResolvedValue({ tokens, sub: 'u', returnTo: '/quotations' });
    m.getMe.mockResolvedValue({ ...CUSTOMER_ME, ...me });
    requestCookies.set(LOGIN_COOKIE, BINDING);

    const res = await call('?code=c&state=s');

    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(`https://portal.localhost${page}`);
    expect(m.createSession).not.toHaveBeenCalled();
    expect(cookiesWritten()).not.toContain('__Host-bos_portal_session');
    expect(m.cookieSet).toHaveBeenCalledWith(LOGIN_COOKIE, '', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 0,
    });
  });

  it('also fails closed when the state is missing or already used', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    m.completeLogin.mockRejectedValue(new Error('state not found'));
    const res = await call('?code=c&state=used');
    expect(res.headers.get('location')).toBe(
      'https://portal.localhost/auth/error?code=callback_failed',
    );
  });
});

describe('/auth/logout', () => {
  const post = (headers: Record<string, string> = {}) =>
    logoutPOST(new Request(`${ORIGIN}/auth/logout`, { method: 'POST', headers }));

  const END_SESSION = 'https://idp.example/oidc/v1/end_session?x=1';

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
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    const res = await post();
    expect(res.status).toBe(403);
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).not.toHaveBeenCalled();
  });

  it('refuses a POST from another origin with 403 and changes nothing', async () => {
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    const res = await post({ origin: 'https://evil.example' });
    expect(res.status).toBe(403);
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).not.toHaveBeenCalled();
  });

  // Without id_token_hint ZITADEL's end_session does not end the user's ZITADEL session, so the
  // next visit signs straight back in. The token is read before the record is destroyed.
  it('destroys the session, clears the cookie and redirects to end_session with the id token hint', async () => {
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    m.peekSession.mockResolvedValue({ idToken: ID_TOKEN });
    m.endSessionUrl.mockResolvedValue(new URL(END_SESSION));

    const res = await post({ origin: ORIGIN });

    expect(m.peekSession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.peekSession.mock.invocationCallOrder[0]).toBeLessThan(
      m.destroySession.mock.invocationCallOrder[0] ?? 0,
    );
    expect(m.getSession).not.toHaveBeenCalled();
    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(m.endSessionUrl).toHaveBeenCalledTimes(1);
    expect(m.endSessionUrl.mock.calls[0]).toEqual([{ idTokenHint: ID_TOKEN }]);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(END_SESSION);
    // ZITADEL ends its session on the hint, so the next login may use its account chooser as usual.
    expect(signedOutWrites()).toEqual([]);
  });

  // CR-06: getSession is null when the record idled out or Valkey is down. The ZITADEL session
  // must still end, or the next visit signs the user straight back in.
  it('with a cookie but no live session: destroys by cookie id, clears it and ends the IdP session without a hint', async () => {
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    m.peekSession.mockResolvedValue(null);
    m.endSessionUrl.mockResolvedValue(new URL(END_SESSION));

    const res = await post({ origin: ORIGIN });

    expect(m.endSessionUrl.mock.calls[0]).toEqual([{}]);
    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(END_SESSION);
    // R2-001: without the hint ZITADEL keeps its session, so the next login must ask for the credentials.
    expect(m.cookieSet).toHaveBeenCalledWith(SIGNED_OUT_COOKIE, '1', {
      ...LOGIN_COOKIE_ATTRS,
      maxAge: 2_592_000,
    });
  });

  it('without any session record at all (idle expiry), sign-out still sets the marker so the next login asks for credentials', async () => {
    m.endSessionUrl.mockResolvedValue(new URL(END_SESSION));
    await post({ origin: ORIGIN });
    expect(signedOutWrites()).toEqual([['1', 2_592_000]]);
  });

  it('without any cookie: clears the cookie and still ends the IdP session', async () => {
    m.endSessionUrl.mockResolvedValue(new URL(END_SESSION));

    const res = await post({ origin: ORIGIN });

    expect(m.peekSession).not.toHaveBeenCalled();
    expect(m.endSessionUrl.mock.calls[0]).toEqual([{}]);
    expect(m.destroySession).not.toHaveBeenCalled();
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(END_SESSION);
  });

  it('when Valkey is down: still clears the cookie, ends the IdP session and logs no id or token', async () => {
    const spies = [
      vi.spyOn(console, 'error').mockImplementation(() => undefined),
      vi.spyOn(console, 'warn').mockImplementation(() => undefined),
      vi.spyOn(console, 'log').mockImplementation(() => undefined),
      vi.spyOn(console, 'info').mockImplementation(() => undefined),
      vi.spyOn(console, 'debug').mockImplementation(() => undefined),
    ];
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    // ioredis puts the command arguments in the error: the key and the stored record.
    const replyError = new Error(`ERR del bos:session:${SESSION_ID} {"idToken":"${ID_TOKEN}"}`);
    replyError.name = 'ReplyError';
    m.peekSession.mockRejectedValue(replyError);
    m.destroySession.mockRejectedValue(replyError);
    m.endSessionUrl.mockResolvedValue(new URL(END_SESSION));

    const res = await post({ origin: ORIGIN });

    // A failed read must not skip the destroy, and no hint is sent without a record.
    expect(m.endSessionUrl.mock.calls[0]).toEqual([{}]);
    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toBe(END_SESSION);

    const logged = spies.flatMap((s) => s.mock.calls).map((args) => JSON.stringify(args));
    expect(logged.join('\n')).toContain('ReplyError');
    for (const secret of [SESSION_ID, ID_TOKEN]) {
      expect(logged.join('\n')).not.toContain(secret);
    }
  });

  it('goes home when ZITADEL discovery fails, after the local session is already gone', async () => {
    requestCookies.set(SESSION_COOKIE, SESSION_ID);
    m.peekSession.mockResolvedValue({ idToken: ID_TOKEN });
    m.endSessionUrl.mockRejectedValue(new Error('discovery down'));
    const res = await post({ origin: ORIGIN });
    expect(m.destroySession).toHaveBeenCalledWith(SESSION_ID);
    expect(m.clearSessionCookie).toHaveBeenCalledTimes(1);
    expect(res.headers.get('location')).toBe('https://portal.localhost/');
    // The IdP session was never asked to end, so the next login must ask for the credentials.
    expect(signedOutWrites()).toEqual([['1', 2_592_000]]);
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
