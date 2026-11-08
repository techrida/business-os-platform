import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import * as client from 'openid-client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import {
  __resetOidcForTests,
  beginLogin,
  completeLogin,
  endSessionUrl,
  getOidcConfig,
  OIDC_SCOPES,
  refreshTokens,
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

function grantResult(fields: {
  access_token: string;
  refresh_token?: string;
  id_token?: string;
  expiresIn?: number;
  sub?: string;
}): GrantResult {
  const { expiresIn, sub, ...body } = fields;
  return {
    ...body,
    token_type: 'bearer',
    expiresIn: () => expiresIn,
    claims: () => (sub === undefined ? undefined : { sub }),
  } as unknown as GrantResult;
}

let redis: Redis;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  __resetOidcForTests();
  redis = new RedisMock();
  await redis.flushall();
  __setRedisForTests(redis);
  vi.mocked(client.discovery).mockReset().mockResolvedValue(config);
  vi.mocked(client.authorizationCodeGrant).mockReset();
  vi.mocked(client.refreshTokenGrant).mockReset();
});

afterEach(() => {
  __setRedisForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

async function pendingLogin(state: string) {
  const raw = await redis.get(`ws:oidc:${state}`);
  return raw === null
    ? null
    : (JSON.parse(raw) as { codeVerifier: string; nonce: string; returnTo: string });
}

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
    const url = await beginLogin({
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
    const a = await beginLogin({ returnTo: '/' });
    const b = await beginLogin({ returnTo: '/' });
    expect(a.searchParams.get('state')).not.toBe(b.searchParams.get('state'));
    expect(a.searchParams.get('nonce')).not.toBe(b.searchParams.get('nonce'));
    expect(a.searchParams.get('code_challenge')).not.toBe(b.searchParams.get('code_challenge'));
  });

  it('sanitises returnTo again and drops unknown prompts and missing hints', async () => {
    const url = await beginLogin({
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
    const url = await beginLogin({ returnTo });
    const state = url.searchParams.get('state') ?? '';
    const pending = await pendingLogin(state);
    return { state, pending };
  }

  it('exchanges the code with the stored verifier, state and nonce', async () => {
    const { state, pending } = await startLogin();
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
    const { state } = await startLogin();
    for (const bad of [
      `http://0.0.0.0:3000/auth/callback?code=abc&state=${state}`,
      `https://evil.example/auth/callback?code=abc&state=${state}`,
      `https://app.test/auth/other?code=abc&state=${state}`,
    ]) {
      await expect(completeLogin(new URL(bad))).rejects.toThrow(/OIDC_REDIRECT_URI/);
    }
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
    expect(await redis.exists(`ws:oidc:${state}`)).toBe(1);
  });

  it('is single use: a replayed callback fails without a second code exchange', async () => {
    const { state } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValue(
      grantResult({ access_token: 'at', expiresIn: 300, sub: 'u' }),
    );
    const callback = new URL(`https://app.test/auth/callback?code=abc&state=${state}`);

    await completeLogin(callback);
    expect(await redis.exists(`ws:oidc:${state}`)).toBe(0);
    await expect(completeLogin(callback)).rejects.toThrow(/already used/);
    expect(client.authorizationCodeGrant).toHaveBeenCalledTimes(1);
  });

  it('consumes the state even when the code exchange fails', async () => {
    const { state } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockRejectedValue(new Error('invalid_grant'));
    const callback = new URL(`https://app.test/auth/callback?code=abc&state=${state}`);
    await expect(completeLogin(callback)).rejects.toThrow('invalid_grant');
    await expect(completeLogin(callback)).rejects.toThrow(/already used/);
  });

  it('rejects an unknown state', async () => {
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=abc&state=${'x'.repeat(43)}`)),
    ).rejects.toThrow(/unknown/);
    expect(client.authorizationCodeGrant).not.toHaveBeenCalled();
  });

  it('rejects a missing or malformed state before touching Redis', async () => {
    const getdel = vi.spyOn(redis, 'getdel');
    await expect(completeLogin(new URL('https://app.test/auth/callback?code=abc'))).rejects.toThrow(
      /state/,
    );
    await expect(
      completeLogin(new URL('https://app.test/auth/callback?code=abc&state=a:b*')),
    ).rejects.toThrow(/state/);
    expect(getdel).not.toHaveBeenCalled();
  });

  it('fails closed without an ID token subject or a token expiry', async () => {
    let { state } = await startLogin();
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({ access_token: 'at', expiresIn: 300 }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`)),
    ).rejects.toThrow(/subject/);

    ({ state } = await startLogin());
    vi.mocked(client.authorizationCodeGrant).mockResolvedValueOnce(
      grantResult({ access_token: 'at', sub: 'u' }),
    );
    await expect(
      completeLogin(new URL(`https://app.test/auth/callback?code=a&state=${state}`)),
    ).rejects.toThrow(/expires_in/);
  });
});

describe('refreshTokens', () => {
  it('runs a refresh grant and maps the response', async () => {
    vi.mocked(client.refreshTokenGrant).mockResolvedValue(
      grantResult({ access_token: 'at2', refresh_token: 'rt2', expiresIn: 120 }),
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
  it('sends the ID token hint, client id and the public URL as post-logout redirect', async () => {
    const url = await endSessionUrl({ idTokenHint: 'idt' });
    expect(url.origin + url.pathname).toBe('https://auth.test/oidc/v1/end_session');
    expect(url.searchParams.get('id_token_hint')).toBe('idt');
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
  });

  it('still names the client when there is no ID token', async () => {
    const url = await endSessionUrl({});
    expect(url.searchParams.has('id_token_hint')).toBe(false);
    expect(url.searchParams.get('client_id')).toBe('client-123');
    expect(url.searchParams.get('post_logout_redirect_uri')).toBe('https://app.test/');
  });
});
