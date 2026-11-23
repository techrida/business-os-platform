import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('server-only', () => ({}));
vi.mock('node:fs/promises', () => ({ readFile: vi.fn().mockResolvedValue('private-login-token') }));
vi.mock('@/lib/oidc', () => ({ beginLogin: vi.fn() }));
import { beginLogin } from '@/lib/oidc';
import {
  developmentAccounts,
  localDevelopmentRequest,
  switchDevelopmentAccount,
} from './accounts.server';
beforeEach(() => {
  vi.stubEnv('NODE_ENV', 'development');
  vi.stubEnv('WORKSPACE_PUBLIC_URL', 'https://app.p1.bos.test');
  vi.stubEnv('OIDC_ISSUER', 'https://auth.p1.bos.test');
  vi.stubEnv('BOS_DEV_LOGIN_CLIENT_TOKEN_FILE', '/private/token');
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
const request = (origin = 'https://app.p1.bos.test', host = 'app.p1.bos.test') =>
  new Request('http://internal/dev/api/accounts', { headers: { host, origin } });
describe('development identity boundary', () => {
  it('accepts configured local stack and rejects foreign origin/host and production', () => {
    expect(localDevelopmentRequest(request(), true)).toBe(true);
    expect(localDevelopmentRequest(request('https://evil.test'), true)).toBe(false);
    expect(
      localDevelopmentRequest(request('https://app.p1.bos.test', 'app.other.bos.test'), true),
    ).toBe(false);
    vi.stubEnv('WORKSPACE_PUBLIC_URL', 'https://example.com');
    expect(localDevelopmentRequest(request(), true)).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(localDevelopmentRequest(request(), true)).toBe(false);
  });
  it('requires exact explicit HTTPS trust and preserves host, port, origin and production boundaries', () => {
    const app = 'https://dev-host.example.net:8443';
    const issuer = 'https://dev-host.example.net:8444';
    vi.stubEnv('WORKSPACE_PUBLIC_URL', app);
    vi.stubEnv('OIDC_ISSUER', issuer);
    const req = (origin = app, host = new URL(app).host) => request(origin, host);
    expect(localDevelopmentRequest(req(), true)).toBe(false);
    vi.stubEnv('BOS_DEV_TRUSTED_ORIGINS', `${app},${issuer}`);
    expect(localDevelopmentRequest(req(), true)).toBe(true);
    expect(localDevelopmentRequest(req(issuer), true)).toBe(false);
    expect(localDevelopmentRequest(req(app, 'dev-host.example.net:9443'), true)).toBe(false);
    expect(localDevelopmentRequest(req('https://other.example.net:8443'), true)).toBe(false);
    expect(
      localDevelopmentRequest(new Request(app, { headers: { host: new URL(app).host } }), true),
    ).toBe(false);
    expect(
      localDevelopmentRequest(
        new Request(app, {
          headers: { host: new URL(app).host, origin: app, 'sec-fetch-site': 'cross-site' },
        }),
        true,
      ),
    ).toBe(false);
    vi.stubEnv('NODE_ENV', 'production');
    expect(localDevelopmentRequest(req(), true)).toBe(false);
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('WORKSPACE_PUBLIC_URL', app.replace('https:', 'http:'));
    expect(localDevelopmentRequest(req(), true)).toBe(false);
  });

  it('keeps privileged identity calls on a validated internal base with redirects refused', async () => {
    vi.stubEnv('BOS_DEV_IDENTITY_API_URL', 'https://auth.p1.bos.test');
    vi.stubEnv('OIDC_ISSUER', 'https://dev-host.example.net:8444');
    const fetchMock = vi.fn().mockResolvedValue(Response.json({ result: [] }));
    vi.stubGlobal('fetch', fetchMock);
    await developmentAccounts();
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('https://auth.p1.bos.test/zitadel.user.v2.UserService/ListUsers'),
      expect.objectContaining({ redirect: 'error' }),
    );
    vi.stubEnv('BOS_DEV_IDENTITY_API_URL', 'https://untrusted.example');
    await expect(developmentAccounts()).rejects.toThrow('Untrusted development origin');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    vi.stubEnv('NODE_ENV', 'production');
    await expect(developmentAccounts()).rejects.toThrow('Development only');
  });

  it('rejects missing origin and cross-site fetches', () => {
    expect(
      localDevelopmentRequest(
        new Request('https://app.p1.bos.test', { headers: { host: 'app.p1.bos.test' } }),
        true,
      ),
    ).toBe(false);
    expect(
      localDevelopmentRequest(
        new Request('https://app.p1.bos.test', {
          headers: {
            host: 'app.p1.bos.test',
            origin: 'https://app.p1.bos.test',
            'sec-fetch-site': 'cross-site',
          },
        }),
        true,
      ),
    ).toBe(false);
  });
  it('discovers manual humans, strips secrets and revalidates disabled users before starting login', async () => {
    const user = {
      userId: '123',
      username: 'manual',
      preferredLoginName: 'manual@test',
      state: 'USER_STATE_ACTIVE',
      human: { profile: { displayName: 'Manual user' }, password: 'never-expose' },
    };
    const fetchMock = vi.fn().mockImplementation(
      () =>
        new Response(
          JSON.stringify({
            result: [
              user,
              { ...user, userId: '456', state: 'USER_STATE_INACTIVE' },
              { ...user, userId: '789', human: undefined, machine: {} },
            ],
          }),
        ),
    );
    vi.stubGlobal('fetch', fetchMock);
    expect(await developmentAccounts()).toEqual([
      { id: '123', label: 'Manual user', login: 'manual@test' },
    ]);
    await expect(switchDevelopmentAccount('456')).rejects.toThrow('Unavailable account');
    expect(beginLogin).not.toHaveBeenCalled();
  });
  it('completes a real auth request with only a user check and exposes only callback and binding', async () => {
    vi.stubEnv('OIDC_REDIRECT_URI', 'https://app.p1.bos.test/auth/callback');
    vi.mocked(beginLogin).mockResolvedValue({
      url: new URL('https://auth.p1.bos.test/oauth/v2/authorize'),
      binding: 'browser-binding',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          result: [
            {
              userId: '123',
              username: 'manual',
              preferredLoginName: 'manual@test',
              state: 'USER_STATE_ACTIVE',
              human: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: '/login?authRequestID=real-request' },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ sessionId: 'private-id', sessionToken: 'private-token' }),
      )
      .mockResolvedValueOnce(
        Response.json({
          callbackUrl: 'https://app.p1.bos.test/auth/callback?code=real-code&state=real-state',
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const result = await switchDevelopmentAccount('123');
    expect(Object.keys(result).sort()).toEqual(['binding', 'callback']);
    expect(result.binding).toBe('browser-binding');
    expect(result.callback.pathname).toBe('/auth/callback');
    expect(fetchMock.mock.calls[2]?.[1]).toMatchObject({
      body: JSON.stringify({ checks: { user: { userId: '123' } }, lifetime: '600s' }),
    });
    expect(fetchMock.mock.calls[3]?.[1]).toMatchObject({
      body: JSON.stringify({ session: { sessionId: 'private-id', sessionToken: 'private-token' } }),
    });
  });
  it('rejects an authorization redirect to a different identity instance before creating a session', async () => {
    vi.mocked(beginLogin).mockResolvedValue({
      url: new URL('https://auth.p1.bos.test/oauth/v2/authorize'),
      binding: 'browser-binding',
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          result: [
            {
              userId: '123',
              username: 'manual',
              preferredLoginName: 'manual@test',
              state: 'USER_STATE_ACTIVE',
              human: {},
            },
          ],
        }),
      )
      .mockResolvedValueOnce(
        new Response(null, {
          status: 302,
          headers: { location: 'https://foreign.bos.test/login?authRequestID=foreign-request' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    await expect(switchDevelopmentAccount('123')).rejects.toThrow('Unexpected login origin');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
