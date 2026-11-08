import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { checkLoginRateLimit, clientIp, LOGIN_RATE_LIMIT, LOGIN_RATE_WINDOW_S } from './rate-limit';
import { getRedis } from './session';

vi.mock('./session', () => ({ getRedis: vi.fn() }));

// Loaded through require for the same reason as in session.test.ts: no reachable types.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);

let redis: Redis;

const req = (headers: Record<string, string> = {}) =>
  new Request('https://app.localhost/auth/login', { headers });

beforeEach(async () => {
  // Fake only Date: ioredis-mock schedules its own work on real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  redis = new RedisMock();
  await redis.flushall(); // ioredis-mock instances share data
  vi.mocked(getRedis).mockReturnValue(redis);
});

afterEach(() => {
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
