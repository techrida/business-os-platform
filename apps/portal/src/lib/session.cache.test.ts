import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import { __setRedisForTests, createSession, getSession, SESSION_COOKIE } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

// Outside a server render React's `cache` calls straight through, so a stand-in memoises by
// argument the way `cache` does inside one render. `renderCache.clear()` starts a new render.
const renderCache = vi.hoisted(() => new Map<unknown, Map<unknown, unknown>>());
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react')>()),
  cache: <A, R>(fn: (arg: A) => R) => {
    const memo = new Map<unknown, unknown>();
    renderCache.set(fn, memo);
    return (arg: A): R => {
      if (!memo.has(arg)) memo.set(arg, fn(arg));
      return memo.get(arg) as R;
    };
  },
}));

const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: vi.fn((name: string) =>
        values.has(name) ? { name, value: values.get(name) as string } : undefined,
      ),
      set: vi.fn(),
    },
  };
});
vi.mock('next/headers', () => ({ cookies: vi.fn(() => Promise.resolve(jar.store)) }));
vi.mock('./oidc', () => ({ refreshTokens: vi.fn() }));

const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const ENV = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'proj-42',
  PORTAL_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://valkey.test:6379',
  SESSION_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_ENC_KEY_ID: 'k1',
};

let redis: Redis;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.UTC(2026, 10, 8, 12, 0, 0));
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  redis = new RedisMock();
  await redis.flushall();
  __setRedisForTests(redis);
  jar.values.clear();
  for (const memo of renderCache.values()) memo.clear();
});

describe('getSession in one render', () => {
  it('three concurrent calls make one Valkey GET and at most one write', async () => {
    const id = await createSession({
      sub: 'user-1',
      orgId: '00000000-0000-4000-8000-000000000002',
      orgKind: 'customer',
      partyId: '00000000-0000-4000-8000-000000000003',
      roles: ['founder'],
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      accessExp: Date.now() / 1000 + 86_400,
    });
    jar.values.set(SESSION_COOKIE, id);
    // Past the 60 s window, so the first read does want to write.
    vi.setSystemTime(Date.now() + 120_000);
    const get = vi.spyOn(redis, 'get');
    const evalSpy = vi.spyOn(redis, 'eval');

    const [a, b, c] = await Promise.all([getSession(), getSession(), getSession()]);

    expect(a).not.toBeNull();
    expect(b).toBe(a);
    expect(c).toBe(a);
    expect(get).toHaveBeenCalledTimes(1);
    expect(evalSpy.mock.calls.length).toBeLessThanOrEqual(1);
  });
});
