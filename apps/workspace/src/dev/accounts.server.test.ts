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
      async () =>
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
});
