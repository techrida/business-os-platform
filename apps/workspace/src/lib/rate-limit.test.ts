import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import { getOidcRedis } from './oidc';
import { checkLoginRateLimit, clientIp, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_S } from './rate-limit';
import { getRedis } from './session';

// The counter lives on the OIDC-state Valkey (CR-03), so it is that client the limiter must use.
// The session client is mocked too, only to prove the limiter never touches it.
vi.mock('./oidc', () => ({ getOidcRedis: vi.fn() }));
vi.mock('./session', () => ({ getRedis: vi.fn() }));

// Loaded through require for the same reason as in session.test.ts: no reachable types.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

let redis: Redis;
let sessionRedis: Redis;

/** The env the limiter reads through `getEnv()`: the real schema, so the override is validated too. */
const ENV = {
  OIDC_ISSUER: 'https://auth.localhost',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.localhost/auth/callback',
  OIDC_AUDIENCE: 'project-1',
  WORKSPACE_PUBLIC_URL: 'https://app.localhost',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://:pw@valkey:6379',
  SESSION_ENC_KEY: Buffer.alloc(32, 7).toString('base64'),
};

const req = (headers: Record<string, string> = {}) =>
  new Request('https://app.localhost/auth/login', { headers });

beforeEach(async () => {
  for (const [name, value] of Object.entries(ENV)) vi.stubEnv(name, value);
  vi.stubEnv('BOS_DEV_LOGIN_RATE_LIMIT', undefined);
  __resetEnvForTests();
  // Fake only Date: ioredis-mock schedules its own work on real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  redis = new RedisMock();
  sessionRedis = new RedisMock();
  await redis.flushall(); // ioredis-mock instances share data
  vi.mocked(getOidcRedis).mockReturnValue(redis);
  vi.mocked(getRedis).mockReturnValue(sessionRedis);
});

afterEach(() => {
  vi.unstubAllEnvs();
  __resetEnvForTests();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('checkLoginRateLimit', () => {
  const ip = { 'x-forwarded-for': '203.0.113.7' };

  it('allows 20 logins per IP in a 60 s window', () => {
    expect(LOGIN_RATE_LIMIT).toBe(20);
    expect(LOGIN_RATE_WINDOW_S).toBe(60);
  });

  it('allows up to the limit and blocks the next one with a Retry-After', async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT; i++) {
      expect(await checkLoginRateLimit(req(ip))).toEqual({ allowed: true });
    }
    const blocked = await checkLoginRateLimit(req(ip));
    expect(blocked).toEqual({ allowed: false, retryAfter: LOGIN_RATE_WINDOW_S });
    expect(await redis.ttl('ws:rl:login:203.0.113.7')).toBe(LOGIN_RATE_WINDOW_S);
  });

  it('blocks the 21st login when BOS_DEV_LOGIN_RATE_LIMIT is not set', async () => {
    for (let i = 1; i <= 20; i++)
      expect(await checkLoginRateLimit(req(ip))).toEqual({ allowed: true });
    expect(await checkLoginRateLimit(req(ip))).toMatchObject({ allowed: false });
  });

  describe('with BOS_DEV_LOGIN_RATE_LIMIT=50', () => {
    beforeEach(() => {
      vi.stubEnv('BOS_DEV_LOGIN_RATE_LIMIT', '50');
      __resetEnvForTests();
    });

    it('allows the 21st login and blocks the 51st', async () => {
      for (let i = 1; i <= 50; i++) {
        expect(await checkLoginRateLimit(req(ip)), `login ${i}`).toEqual({ allowed: true });
      }
      expect(await checkLoginRateLimit(req(ip))).toEqual({
        allowed: false,
        retryAfter: LOGIN_RATE_WINDOW_S,
      });
    });

    it('leaves the exported production constant at 20', () => {
      expect(LOGIN_RATE_LIMIT).toBe(20);
    });
  });

  it('keeps the counter on the OIDC-state Valkey, with a TTL, and never on the session Valkey', async () => {
    const sessionEval = vi.spyOn(sessionRedis, 'eval');
    expect(await checkLoginRateLimit(req(ip))).toEqual({ allowed: true });
    expect(getRedis).not.toHaveBeenCalled();
    expect(sessionEval).not.toHaveBeenCalled();
    // volatile-ttl only evicts keys that have a TTL, so the counter must carry one.
    expect(await redis.get('ws:rl:login:203.0.113.7')).toBe('1');
    expect(await redis.ttl('ws:rl:login:203.0.113.7')).toBe(LOGIN_RATE_WINDOW_S);
  });

  it('stays on when the session Valkey is down, because it does not use it', async () => {
    vi.mocked(getRedis).mockImplementation(() => {
      throw new Error('session valkey down');
    });
    for (let i = 0; i < LOGIN_RATE_LIMIT; i++) await checkLoginRateLimit(req(ip));
    expect(await checkLoginRateLimit(req(ip))).toMatchObject({ allowed: false });
  });

  it('counts each IP separately', async () => {
    for (let i = 0; i < LOGIN_RATE_LIMIT; i++) await checkLoginRateLimit(req(ip));
    expect(await checkLoginRateLimit(req(ip))).toMatchObject({ allowed: false });
    expect(await checkLoginRateLimit(req({ 'x-forwarded-for': '198.51.100.1' }))).toEqual({
      allowed: true,
    });
  });

  it('resets after the window', async () => {
    for (let i = 0; i <= LOGIN_RATE_LIMIT; i++) await checkLoginRateLimit(req(ip));
    expect(await checkLoginRateLimit(req(ip))).toMatchObject({ allowed: false });
    vi.setSystemTime(T0 + LOGIN_RATE_WINDOW_S * 1000);
    expect(await checkLoginRateLimit(req(ip))).toEqual({ allowed: true });
  });

  it('sets an expiry on a counter that somehow lost it, so it cannot block forever', async () => {
    await redis.set('ws:rl:login:203.0.113.7', '500');
    expect(await checkLoginRateLimit(req(ip))).toMatchObject({ allowed: false });
    expect(await redis.ttl('ws:rl:login:203.0.113.7')).toBe(LOGIN_RATE_WINDOW_S);
  });

  it('fails open with a warning that carries no command arguments when Valkey errors', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const err = Object.assign(new Error('OOM command not allowed'), {
      command: { name: 'eval', args: ['ws:rl:login:203.0.113.7'] },
    });
    vi.spyOn(redis, 'eval').mockRejectedValue(err);
    expect(await checkLoginRateLimit(req(ip))).toEqual({ allowed: true });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('203.0.113.7');
  });
});

describe('clientIp', () => {
  it.each([
    [{ 'x-forwarded-for': '203.0.113.7' }, '203.0.113.7'],
    [{ 'x-forwarded-for': ' 203.0.113.7 , 10.0.0.1' }, '203.0.113.7'],
    [{ 'x-forwarded-for': '2001:db8::1' }, '2001:db8::1'],
    [{ 'x-real-ip': '198.51.100.1' }, '198.51.100.1'],
    [{ 'x-forwarded-for': 'garbage', 'x-real-ip': '198.51.100.1' }, '198.51.100.1'],
    [{ 'x-forwarded-for': 'a'.repeat(500) }, 'unknown'],
    [{ 'x-forwarded-for': '1.2.3.4:5/../x' }, 'unknown'],
    [{}, 'unknown'],
  ])('%j -> %s', (headers, expected) => {
    expect(clientIp(new Headers(headers))).toBe(expected);
  });
});
