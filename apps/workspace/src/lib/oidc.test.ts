import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import * as client from 'openid-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import {
  __resetOidcForTests,
  __setOidcRedisForTests,
  beginLogin,
  completeLogin,
  endSessionUrl,
  getOidcConfig,
  getOidcRedis,
  LOGIN_COOKIE,
  LOGIN_COOKIE_MAX_AGE,
  LoginBindingError,
  OIDC_SCOPES,
  refreshTokens,
  StaleSignInError,
} from './oidc';
import { __setRedisForTests } from './session';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
// Keep the real URL builders and PKCE helpers; stub only what talks to the network.
vi.mock('openid-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('openid-client')>();
  return {
    ...actual,
    discovery: vi.fn(),
    authorizationCodeGrant: vi.fn(),
    refreshTokenGrant: vi.fn(),
  };
});

// See session.test.ts: ioredis-mock types are not reachable from this package.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const ENV = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'proj-42',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://valkey.test:6379',
  OIDC_STATE_VALKEY_URL: 'redis://valkey-oidc.test:6380',
  SESSION_ENC_KEY: Buffer.alloc(32, 3).toString('base64'),
};

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

/** A real Configuration, so buildAuthorizationUrl and buildEndSessionUrl run for real. */
const config = new client.Configuration(
  {
    issuer: 'https://auth.test',
    authorization_endpoint: 'https://auth.test/oauth/v2/authorize',
    token_endpoint: 'https://auth.test/oauth/v2/token',
    end_session_endpoint: 'https://auth.test/oidc/v1/end_session',
    jwks_uri: 'https://auth.test/oauth/v2/keys',
  },
  'client-123',
  undefined,
  client.None(),
);

type GrantResult = Awaited<ReturnType<typeof client.authorizationCodeGrant>>;
type RefreshResult = Awaited<ReturnType<typeof client.refreshTokenGrant>>;

function grantResult<T extends GrantResult | RefreshResult = GrantResult>(fields: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expiresIn?: number;
  sub?: string;
  authTime?: number;
}): T {
  const { expiresIn, sub, authTime, ...body } = fields;
  return {
    ...body,
    token_type: 'bearer',
    expiresIn: () => expiresIn,
    claims: () =>
      sub === undefined
        ? undefined
        : { sub, ...(authTime !== undefined && { auth_time: authTime }) },
  } as unknown as T;
}

/** The OIDC state client. */
let redis: Redis;
/** The session client: login state must never land here (CR-03). */
let sessionRedis: Redis;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  __resetOidcForTests();
  redis = new RedisMock();
  await redis.flushall();
  __setOidcRedisForTests(redis);
  // ioredis-mock instances share data, so separation is asserted with spies on this one.
  sessionRedis = new RedisMock();
  __setRedisForTests(sessionRedis);
  vi.mocked(client.discovery).mockReset().mockResolvedValue(config);
  vi.mocked(client.authorizationCodeGrant).mockReset();
  vi.mocked(client.refreshTokenGrant).mockReset();
});

afterEach(() => {
  __setOidcRedisForTests(undefined);
  __setRedisForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function pendingLogin(state: string) {
  const raw = await redis.get(`ws:oidc:${state}`);
  return raw === null
    ? null
    : (JSON.parse(raw) as {
        codeVerifier: string;
        nonce: string;
        returnTo: string;
        bindingHash: string;
        reauthAfter?: number;
      });
}

const sha256Hex = (v: string) => createHash('sha256').update(v).digest('hex');

describe('LOGIN_COOKIE', () => {
  it('is a __Host- cookie, so only this exact origin can set or read it', () => {
    expect(LOGIN_COOKIE).toBe('__Host-bos_login');
  });

  it('lives exactly as long as the stored login state', () => {
    expect(LOGIN_COOKIE_MAX_AGE).toBe(600);
  });
});

describe('OIDC_SCOPES', () => {
  it('requests a refresh token, the project audience and the resource owner', () => {
    expect(OIDC_SCOPES).toBe(
      'openid profile email offline_access urn:zitadel:iam:org:project:id:{aud}:aud urn:zitadel:iam:user:resourceowner',
    );
  });
});

describe('getOidcConfig', () => {
  it('does not run discovery until first use', () => {
    expect(client.discovery).not.toHaveBeenCalled();
  });

  it('discovers once from the issuer as a public client and caches the result', async () => {
    const [a, b] = await Promise.all([getOidcConfig(), getOidcConfig()]);
    await getOidcConfig();
    expect(a).toBe(config);
    expect(b).toBe(config);
    expect(client.discovery).toHaveBeenCalledTimes(1);
    const [issuer, clientId, metadata, auth] = vi.mocked(client.discovery).mock.calls[0] ?? [];
    expect(issuer?.href).toBe('https://auth.test/');
    expect(clientId).toBe('client-123');
    expect(metadata).toBeUndefined();
    expect(typeof auth).toBe('function'); // None(): no client secret
  });

  it('does not cache a failed discovery', async () => {
    vi.mocked(client.discovery).mockRejectedValueOnce(new Error('ECONNREFUSED'));
    await expect(getOidcConfig()).rejects.toThrow('ECONNREFUSED');
    await expect(getOidcConfig()).resolves.toBe(config);
    expect(client.discovery).toHaveBeenCalledTimes(2);
  });
});

describe('beginLogin', () => {
  it('builds a PKCE S256 authorization URL and stores the login state for 10 minutes', async () => {
    const { url } = await beginLogin({
      loginHint: 'ada@bos.test',
      prompt: 'login',
      returnTo: '/orders',
    });
    expect(url.origin + url.pathname).toBe('https://auth.test/oauth/v2/authorize');

    const p = url.searchParams;
    expect(p.get('client_id')).toBe('client-123');
    expect(p.get('response_type')).toBe('code');
    expect(p.get('redirect_uri')).toBe('https://app.test/auth/callback');
    expect(p.get('scope')).toBe(
      'openid profile email offline_access urn:zitadel:iam:org:project:id:proj-42:aud urn:zitadel:iam:user:resourceowner',
    );
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('login_hint')).toBe('ada@bos.test');
    expect(p.get('prompt')).toBe('login');

    const state = p.get('state') ?? '';
    const pending = await pendingLogin(state);
    expect(pending).not.toBeNull();
    expect(pending?.returnTo).toBe('/orders');
    expect(p.get('nonce')).toBe(pending?.nonce);
    expect(p.get('code_challenge')).toBe(
      await client.calculatePKCECodeChallenge(pending?.codeVerifier ?? ''),
    );
    // The verifier never leaves the server.
    expect(url.href).not.toContain(pending?.codeVerifier);
    const ttl = await redis.ttl(`ws:oidc:${state}`);
    expect(ttl).toBeGreaterThan(590);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it('uses a fresh state, nonce and verifier per login', async () => {
    const { url: a } = await beginLogin({ returnTo: '/' });
    const { url: b } = await beginLogin({ returnTo: '/' });
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
    expect(a.searchParams.get('nonce')).not.toBe(b.searchParams.get('nonce'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });

  it('returns a fresh 32-byte browser binding and stores only its SHA-256', async () => {
    const a = await beginLogin({ returnTo: '/' });
    const b = await beginLogin({ returnTo: '/' });
    expect(a.binding).toMatch(/^[A-Za-z0-9_-]{43}$/); // 32 bytes, base64url, no padding
    expect(Buffer.from(a.binding, 'base64url')).toHaveLength(32);
    expect(a.binding).not.toBe(b.binding);

    const pending = await pendingLogin(a.url.searchParams.get('state') ?? '');
    expect(pending?.bindingHash).toBe(sha256Hex(a.binding));
    // Neither the binding nor its hash goes to the IdP, and Valkey never sees the raw value.
    expect(a.url.href).not.toContain(a.binding);
    expect(a.url.href).not.toContain(sha256Hex(a.binding));
    expect(JSON.stringify(pending)).not.toContain(a.binding);
  });

  it('sends max_age for step-up (K7) and omits it by default', async () => {
    const { url } = await beginLogin({ returnTo: '/', prompt: 'login', maxAge: 0 });
    expect(url.searchParams.get('max_age')).toBe('0');
    const { url: plain } = await beginLogin({ returnTo: '/' });
    expect(plain.searchParams.has('max_age')).toBe(false);
  });

  it('records when a prompt=login login began, and nothing for other logins', async () => {
    const { url: forced } = await beginLogin({ returnTo: '/', prompt: 'login', maxAge: 0 });
    expect((await pendingLogin(forced.searchParams.get('state') ?? ''))?.reauthAfter).toBe(
      T0 / 1000,
    );
    const { url: plain } = await beginLogin({ returnTo: '/', prompt: 'none' });
    expect(await pendingLogin(plain.searchParams.get('state') ?? '')).not.toHaveProperty(
      'reauthAfter',
    );
  });

  it.each([-1, 1.5, Number.NaN, 86_401])('drops a max_age of %s', async (maxAge) => {
    const { url } = await beginLogin({ returnTo: '/', maxAge });
    expect(url.searchParams.has('max_age')).toBe(false);
  });

  it('sanitises returnTo again and drops unknown prompts and missing hints', async () => {
    const { url } = await beginLogin({
      returnTo: '//evil.example',
      prompt: 'bogus' as 'login',
    });
    expect(url.searchParams.has('prompt')).toBe(false);
    expect(url.searchParams.has('login_hint')).toBe(false);
    expect((await pendingLogin(url.searchParams.get('state') ?? ''))?.returnTo).toBe('/');
  });
});

describe('completeLogin', () => {
  async function startLogin(returnTo = '/orders') {
    const { url, binding } = await beginLogin({ returnTo });
    const state = url.searchParams.get('state') ?? '';
    const pending = await pendingLogin(state);
    return { state, pending, binding };
  }

  it('exchanges the code with the stored verifier, state and nonce', async () => {
    const { state, pending, binding } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({
        access_token: 'at',
        refresh_token: 'rt',
        id_token: 'idt',
        expiresIn: 300,
        sub: 'user-1',
      }),
    );

    const result = await completeLogin(
      new URL(`https://app.test/auth/callback?code=abc&state=${state}`),
      binding,
    );

    expect(result).toEqual({
      tokens: { accessToken: 'at', refreshToken: 'rt', idToken: 'idt', accessExp: T0 / 1000 + 300 },
      sub: 'user-1',
      returnTo: '/orders',
    });
    const [cfg, currentUrl, checks] = vi.mocked(client.authorizationCodeGrant).mock.calls[0] ?? [];
    expect(cfg).toBe(config);
    expect((currentUrl as URL).href).toBe(`https://app.test/auth/callback?code=abc&state=${state}`);
    expect(checks).toEqual({
      pkceCodeVerifier: pending?.codeVerifier,
      expectedState: state,
      expectedNonce: pending?.nonce,
      idTokenExpected: true,
    });
  });

  it('refuses a callback URL that is not OIDC_REDIRECT_URI, without consuming the state', async () => {
    const { state, binding } = await startLogin();
    for (const bad of [
      `http://0.0.0.0:3000/auth/callback?code=abc&state=${state}`,
      `https://evil.example/auth/callback?code=abc&state=${state}`,
      `https://app.test/auth/other?code=abc&state=${state}`,
    ]) {
      await expect(completeLogin(new URL(bad), binding)).rejects.toThrow(/OIDC_REDIRECT_URI/);
    }
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(await redis.exists(`ws:oidc:${state}`)).toBe(1);
  });

  it('is single use: a replayed callback fails without a second code exchange', async () => {
    const { state, binding } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ access_token: 'at', expiresIn: 300, sub: 'u' }),
    );
    const callback = new URL(`https://app.test/auth/callback?code=abc&state=${state}`);

    await completeLogin(callback, binding);
    expect(await redis.exists(`ws:oidc:${state}`)).toBe(0);
    await expect(completeLogin(callback, binding)).rejects.toThrow(/already used/);
    expect(client.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });

  it('consumes the state even when the code exchange fails', async () => {
    const { state, binding } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockRejectedValue(new Error('invalid_grant'));
    const callback = new URL(`https://app.test/auth/callback?code=abc&state=${state}`);
    await expect(completeLogin(callback, binding)).rejects.toThrow('invalid_grant');
    await expect(completeLogin(callback, binding)).rejects.toThrow(/already used/);
  });

  // CR-01: without the binding, anyone could send a victim their own callback link and sign
  // the victim into the attacker's account (login CSRF). PKCE does not bind the browser.
  it('refuses a callback without the login cookie, before any token request, and burns the state', async () => {
    const { state, binding } = await startLogin();
    const callback = new URL(`https://app.test/auth/callback?code=abc&state=${state}`);

    const err = await completeLogin(callback, undefined).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(LoginBindingError);
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(await redis.exists(`ws:oidc:${state}`)).toBe(0);
    // The state is gone, so even the right cookie cannot finish this login afterwards.
    await expect(completeLogin(callback, binding)).rejects.toThrow(/already used/);

    const other = await startLogin();
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=abc&state=${other.state}`), ''),
    ).rejects.toBeInstanceOf(LoginBindingError);
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('refuses a callback whose login cookie belongs to another login, before any token request', async () => {
    const victim = await startLogin();
    // Wrong lengths too: comparing raw input with timingSafeEqual would throw, not refuse.
    for (const wrong of [victim.binding, 'x'.repeat(43), 'short', 'y'.repeat(500)]) {
      const { state } = await startLogin();
      const err = await completeLogin(
        new URL(`https://app.test/auth/callback?code=abc&state=${state}`),
        wrong,
      ).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LoginBindingError);
      expect(await redis.exists(`ws:oidc:${state}`)).toBe(0);
    }
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('completes when the login cookie matches the one set at /auth/login', async () => {
    const { state, binding } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ access_token: 'at', expiresIn: 300, sub: 'u' }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=abc&state=${state}`), binding),
    ).resolves.toMatchObject({ sub: 'u' });
    expect(client.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });

  it('treats a stored login without a binding hash as corrupt', async () => {
    const state = 'z'.repeat(43);
    await redis.set(
      `ws:oidc:${state}`,
      JSON.stringify({ codeVerifier: 'v'.repeat(43), nonce: 'n', returnTo: '/' }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=abc&state=${state}`), 'b'),
    ).rejects.toThrow(/corrupt/);
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects an unknown state', async () => {
    await expect(
      completeLogin(
        new URL(`https://app.test/auth/callback?code=abc&state=${'x'.repeat(43)}`),
        'b',
      ),
    ).rejects.toThrow(/unknown/);
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed state before touching Redis', async () => {
    const getdel = vi.spyOn(redis, 'getdel');
    await expect(
      completeLogin(new URL('https://app.test/auth/callback?code=abc'), 'b'),
    ).rejects.toThrow(/state/);
    await expect(
      completeLogin(new URL('https://app.test/auth/callback?code=abc&state=a:b*'), 'b'),
    ).rejects.toThrow(/state/);
    expect(getdel).not.toHaveBeenCalled();
  });

  it('fails closed without an ID token subject or a token expiry', async () => {
    let { state, binding } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({ access_token: 'at', expiresIn: 300 }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`), binding),
    ).rejects.toThrow(/subject/);

    ({ state, binding } = await startLogin());
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({ access_token: 'at', sub: 'u' }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`), binding),
    ).rejects.toThrow(/expires_in/);
  });
});

// ZITADEL v4.20.1 checks prompt=login only in its login UI. Its server links any live session to the request, so
// a session picked from the account list would come back here with the old auth_time.
describe('completeLogin after prompt=login', () => {
  const NOW = T0 / 1000;

  async function forcedLogin(authTime: number | undefined) {
    const { url, binding } = await beginLogin({ returnTo: '/', prompt: 'login', maxAge: 0 });
    const state = url.searchParams.get('state') ?? '';
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({
        access_token: 'at',
        expiresIn: 300,
        sub: 'u',
        ...(authTime !== undefined && { authTime }),
      }),
    );
    return completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`), binding);
  }

  it('accepts a sign-in made after the login began', async () => {
    vi.setSystemTime(T0 + 45_000); // password and TOTP typed in 45 s
    await expect(forcedLogin(NOW + 40)).resolves.toMatchObject({ sub: 'u' });
  });

  it('accepts up to 60 s of clock difference with ZITADEL', async () => {
    await expect(forcedLogin(NOW - 60)).resolves.toMatchObject({ sub: 'u' });
  });

  it('refuses a reused ZITADEL session: auth_time from before the login began', async () => {
    await expect(forcedLogin(NOW - 3_700)).rejects.toBeInstanceOf(StaleSignInError);
    await expect(forcedLogin(NOW - 61)).rejects.toBeInstanceOf(StaleSignInError);
  });

  it('refuses an ID token without auth_time', async () => {
    await expect(forcedLogin(undefined)).rejects.toBeInstanceOf(StaleSignInError);
  });

  it('does not check auth_time on a login that did not ask for prompt=login', async () => {
    const { url, binding } = await beginLogin({ returnTo: '/' });
    const state = url.searchParams.get('state') ?? '';
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({ access_token: 'at', expiresIn: 300, sub: 'u', authTime: NOW - 86_000 }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`), binding),
    ).resolves.toMatchObject({ sub: 'u' });
  });
});

describe('refreshTokens', () => {
  it('runs a refresh grant and maps the response', async () => {
    vi.mocked(client.refreshTokenGrant).mockResolvedValue(
      grantResult<RefreshResult>({ access_token: 'at2', refresh_token: 'rt2', expiresIn: 120 }),
    );
    await expect(refreshTokens('rt1')).resolves.toEqual({
      accessToken: 'at2',
      refreshToken: 'rt2',
      accessExp: T0 / 1000 + 120,
    });
    expect(client.refreshTokenGrant).toHaveBeenCalledWith(config, 'rt1');
  });

  it('propagates a failed refresh', async () => {
    vi.mocked(client.refreshTokenGrant).mockRejectedValue(new Error('invalid_grant'));
    await expect(refreshTokens('rt1')).rejects.toThrow('invalid_grant');
  });
});

describe('endSessionUrl', () => {
  // Without id_token_hint ZITADEL's end_session leaves the user's ZITADEL session alive, and the
  // next visit signs straight back in. The hint travels in the redirect URL (the CR-05a
  // exposure, accepted: the ID token is not a bearer credential for the API). client_id ties
  // post_logout_redirect_uri to the client either way.
  it('sends the ID token hint, the client id and the post-logout redirect when given a hint', async () => {
    const url = await endSessionUrl({ idTokenHint: 'idt-1' });
    expect(url.origin + url.pathname).toBe('https://auth.test/oidc/v1/end_session');
    expect(url.searchParams.get('id_token_hint')).toBe('idt-1');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
  });

  it('sends no id_token_hint without one, but still the client id and the redirect', async () => {
    for (const url of [await endSessionUrl(), await endSessionUrl({})]) {
      expect(url.origin + url.pathname).toBe('https://auth.test/oidc/v1/end_session');
      expect(url.searchParams.has('id_token_hint')).toBe(false);
      expect(url.searchParams.get('client_id')).toBe('client-123');
      expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
    }
  });
});

// CR-03: login state lives on its own Valkey, so anonymous logins cannot fill the session server.
describe('OIDC state Valkey', () => {
  it('stores and consumes login state on the OIDC client, never on the session client', async () => {
    const sessionCalls = [
      vi.spyOn(sessionRedis, 'set'),
      vi.spyOn(sessionRedis, 'get'),
      vi.spyOn(sessionRedis, 'getdel'),
    ];
    const oidcSet = vi.spyOn(redis, 'set');
    const oidcGetdel = vi.spyOn(redis, 'getdel');

    const { url } = await beginLogin({ returnTo: '/' });
    const state = url.searchParams.get('state') as string;
    expect(oidcSet).toHaveBeenCalledWith(`ws:oidc:${state}`, expect.any(String), 'EX', 600);

    await completeLogin(
      new URL(`https://app.test/auth/callback?code=c&state=${state}`),
      'not-the-binding',
    ).catch(() => undefined);
    expect(oidcGetdel).toHaveBeenCalledWith(`ws:oidc:${state}`);
    for (const spy of sessionCalls) expect(spy).not.toHaveBeenCalled();
  });

  it('connects to OIDC_STATE_VALKEY_URL and fails fast in an outage', () => {
    __setOidcRedisForTests(undefined);
    const client = getOidcRedis();
    try {
      expect(client.options).toMatchObject({
        host: 'valkey-oidc.test',
        port: 6380,
        commandTimeout: 1000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    } finally {
      client.disconnect();
    }
  });
});
