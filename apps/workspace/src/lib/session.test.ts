import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';

import type { Redis, RedisKey } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import { refreshTokens } from './oidc';
import {
  __setRedisForTests,
  ABSOLUTE_SECONDS,
  clearSessionCookie,
  createSession,
  destroySession,
  getRedis,
  getSession,
  IDLE_SECONDS,
  peekSession,
  safeReturnTo,
  SESSION_COOKIE,
  setSessionCookie,
} from './session';
import { type Keyring, openSessionValue, sealSessionValue } from './session-crypto';
import { SessionUnavailableError } from './session-unavailable';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const jar = vi.hoisted(() => {
  const values = new Map<string, string>();
  return {
    values,
    store: {
      get: vi.fn((name: string) =>
        values.has(name) ? { name, value: values.get(name) as string } : undefined,
      ),
      set: vi.fn((name: string, value: string, _options?: unknown) => {
        values.set(name, value);
      }),
    },
  };
});
vi.mock('next/headers', () => ({ cookies: vi.fn(() => Promise.resolve(jar.store)) }));
vi.mock('./oidc', () => ({ refreshTokens: vi.fn() }));

// ioredis-mock has no types reachable from this package (pnpm keeps @types/ioredis-mock out of
// reach), so it is loaded through require and typed as the real client it imitates.
const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

const T0 = Date.UTC(2026, 10, 8, 12, 0, 0);
const T0_SECONDS = T0 / 1000;
const FAR_FUTURE = T0_SECONDS + 30 * 86400;

const BASE = {
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff' as const,
  roles: ['founder'],
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExp: FAR_FUTURE,
};

const ENC_KEY = Buffer.alloc(32, 9);
const RING: Keyring = { currentId: 'k1', keys: new Map([['k1', ENC_KEY]]) };

const ENV = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'proj-42',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://valkey.test:6379',
  SESSION_ENC_KEY: ENC_KEY.toString('base64'),
  SESSION_ENC_KEY_ID: 'k1',
};

let redis: Redis;

function advance(seconds: number) {
  vi.setSystemTime(Date.now() + seconds * 1000);
}

/** The Valkey key of a session, computed here independently of session.ts. */
function keyFor(id: string): string {
  return `ws:sess:${createHash('sha256').update(id).digest('hex')}`;
}

/** The decrypted record of a session, or null when there is none. */
async function stored(id: string): Promise<Record<string, unknown> | null> {
  const raw = await redis.get(keyFor(id));
  if (raw === null) return null;
  const plain = openSessionValue(raw, keyFor(id), RING);
  if (plain === null) throw new Error('stored value does not decrypt');
  return JSON.parse(plain) as Record<string, unknown>;
}

async function signedIn(overrides: Partial<typeof BASE> = {}): Promise<string> {
  const id = await createSession({ ...BASE, ...overrides });
  jar.values.set(SESSION_COOKIE, id);
  return id;
}

beforeEach(async () => {
  // Fake only Date: ioredis-mock schedules its own work on real timers.
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(T0);
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  redis = new RedisMock();
  await redis.flushall(); // ioredis-mock instances share data
  __setRedisForTests(redis);
  jar.values.clear();
  vi.mocked(refreshTokens).mockReset();
  jar.store.set.mockClear();
});

afterEach(() => {
  __setRedisForTests(undefined);
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('createSession', () => {
  it('stores the record under a 256-bit base64url id with the idle TTL', async () => {
    const id = await createSession(BASE);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(Buffer.from(id, 'base64url')).toHaveLength(32);
    expect(await stored(id)).toEqual({ ...BASE, createdAt: T0_SECONDS, lastSeenAt: T0_SECONDS });
    expect(await redis.ttl(keyFor(id))).toBe(IDLE_SECONDS);
  });

  // Logout sends it as id_token_hint: without it ZITADEL keeps its own session alive.
  it('stores the ID token only inside the encrypted envelope', async () => {
    const idToken = 'id-secret-1.payload.sig';
    const id = await createSession({ ...BASE, idToken });
    expect(await stored(id)).toHaveProperty('idToken', idToken);
    const raw = (await redis.get(keyFor(id))) ?? '';
    for (const form of [
      idToken,
      Buffer.from(idToken).toString('base64'),
      Buffer.from(idToken).toString('base64url'),
    ]) {
      expect(raw).not.toContain(form);
    }
  });

  it('gives every session a different id', async () => {
    const ids = new Set(await Promise.all([1, 2, 3, 4, 5].map(() => createSession(BASE))));
    expect(ids.size).toBe(5);
  });
});

describe('session cookie', () => {
  it('sets __Host-bos_session as HttpOnly, Secure, SameSite=Lax, Path=/ with no Domain', async () => {
    await setSessionCookie('abc');
    expect(jar.store.set).toHaveBeenCalledWith('__Host-bos_session', 'abc', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: ABSOLUTE_SECONDS,
    });
  });

  it('clears it with the same attributes, so the browser accepts the __Host- overwrite', async () => {
    await clearSessionCookie();
    expect(jar.store.set).toHaveBeenCalledWith('__Host-bos_session', '', {
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  });
});

describe('getSession', () => {
  it('returns null without a cookie', async () => {
    expect(await getSession()).toBeNull();
  });

  it('returns null for a malformed cookie without building a Redis key from it', async () => {
    const getSpy = vi.spyOn(redis, 'get');
    jar.values.set(SESSION_COOKIE, '../../ws:oidc:x');
    expect(await getSession()).toBeNull();
    expect(getSpy).not.toHaveBeenCalled();
  });

  it('returns null for an unknown id', async () => {
    jar.values.set(SESSION_COOKIE, 'A'.repeat(43));
    expect(await getSession()).toBeNull();
  });

  it('returns the session and slides lastSeenAt and the TTL', async () => {
    const id = await signedIn();
    advance(1800);
    const s = await getSession();
    expect(s).toMatchObject({ id, ...BASE, createdAt: T0_SECONDS, lastSeenAt: T0_SECONDS + 1800 });
    expect((await stored(id))?.lastSeenAt).toBe(T0_SECONDS + 1800);
    expect(await redis.ttl(keyFor(id))).toBe(IDLE_SECONDS);
  });

  it('rejects and destroys a session idle for an hour', async () => {
    const id = await signedIn();
    advance(IDLE_SECONDS);
    expect(await getSession()).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('keeps an active session alive just under the idle limit', async () => {
    await signedIn();
    for (let i = 0; i < 3; i++) {
      advance(IDLE_SECONDS - 1);
      expect(await getSession()).not.toBeNull();
    }
  });

  it('caps the TTL at the absolute limit and rejects at 24 h however active', async () => {
    const id = await signedIn();
    // Stay active every 50 minutes until 30 minutes before the absolute limit.
    const steps = Math.floor((ABSOLUTE_SECONDS - 1800) / 3000);
    for (let i = 0; i < steps; i++) {
      advance(3000);
      expect(await getSession()).not.toBeNull();
    }
    const elapsed = steps * 3000;
    advance(ABSOLUTE_SECONDS - 1800 - elapsed);
    expect(await getSession()).not.toBeNull();
    // 30 minutes of absolute lifetime left, which is less than the 1 h idle window.
    expect(await redis.ttl(keyFor(id))).toBe(1800);

    advance(1800);
    expect(await getSession()).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('destroys a corrupt record', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn();
    await redis.set(keyFor(id), JSON.stringify({ sub: 'x', orgKind: 'admin' }));
    expect(await getSession()).toBeNull();
    expect(await redis.exists(keyFor(id))).toBe(0);
  });

  it('destroys a record that decrypts but fails the schema', async () => {
    const id = await signedIn();
    const bad = JSON.stringify({ sub: 'x', orgKind: 'admin' });
    await redis.set(keyFor(id), sealSessionValue(bad, keyFor(id), RING));
    expect(await getSession()).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('does not resurrect a session deleted while it was being read', async () => {
    const id = await signedIn();
    advance(120); // past the 60 s window in which a read does not write
    const realGet = redis.get.bind(redis);
    // Simulate a concurrent logout landing between our GET and the write-back.
    vi.spyOn(redis, 'get').mockImplementationOnce(async (key: RedisKey) => {
      const value = await realGet(key);
      await redis.del(key);
      return value;
    });
    expect(await getSession()).toBeNull();
    expect(await stored(id)).toBeNull();
  });
});

describe('getSession idle timer', () => {
  it('does not write when the record was written less than 60 s ago', async () => {
    const id = await signedIn();
    const evalSpy = vi.spyOn(redis, 'eval');
    advance(59);
    await expect(getSession()).resolves.toMatchObject({ id, lastSeenAt: T0_SECONDS });
    expect(evalSpy).not.toHaveBeenCalled();
    expect((await stored(id))?.lastSeenAt).toBe(T0_SECONDS);
  });

  it('writes again once 60 s have passed since the last write', async () => {
    const id = await signedIn();
    advance(60);
    await expect(getSession()).resolves.toMatchObject({ id, lastSeenAt: T0_SECONDS + 60 });
    expect((await stored(id))?.lastSeenAt).toBe(T0_SECONDS + 60);
  });

  it('does not slide with { slide: false }: 240 polls over 61 minutes leave the session expired', async () => {
    const id = await signedIn();
    const evalSpy = vi.spyOn(redis, 'eval');
    let signedInAfterAnHour = false;
    for (let poll = 1; poll <= 244; poll++) {
      advance(15);
      const s = await getSession({ slide: false });
      if (Date.now() / 1000 - T0_SECONDS >= IDLE_SECONDS && s !== null) signedInAfterAnHour = true;
    }
    expect(signedInAfterAnHour).toBe(false);
    expect(await getSession({ slide: false })).toBeNull();
    expect(await stored(id)).toBeNull();
    // Background reads never wrote the session.
    expect(evalSpy).not.toHaveBeenCalled();
  });

  it('keeps tokens fresh on a background read without renewing the idle timer', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 30 });
    advance(1800);
    vi.mocked(refreshTokens).mockResolvedValue({
      accessToken: 'access-2',
      accessExp: T0_SECONDS + 1800 + 300,
    });
    const s = await getSession({ slide: false });
    expect(s).toMatchObject({ accessToken: 'access-2', lastSeenAt: T0_SECONDS });
    expect(await stored(id)).toMatchObject({ accessToken: 'access-2', lastSeenAt: T0_SECONDS });
    // 1800 s of the hour are left, not a fresh hour.
    expect(await redis.ttl(keyFor(id))).toBe(IDLE_SECONDS - 1800);
  });

  it('a sliding read after background reads still renews the timer', async () => {
    const id = await signedIn();
    advance(1800);
    await getSession({ slide: false });
    await getSession();
    expect((await stored(id))?.lastSeenAt).toBe(T0_SECONDS + 1800);
  });
});

describe('getSession token refresh', () => {
  it('refreshes when fewer than 60 s are left and stores the rotated tokens', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 59 });
    vi.mocked(refreshTokens).mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessExp: T0_SECONDS + 300,
    });

    const s = await getSession();
    expect(refreshTokens).toHaveBeenCalledWith('refresh-1');
    expect(s).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(await stored(id)).toMatchObject({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessExp: T0_SECONDS + 300,
    });
    expect(await redis.exists(`${keyFor(id)}:refresh`)).toBe(0); // lock released
  });

  it('stores a new ID token from the refresh but never returns it from getSession', async () => {
    const id = await createSession({ ...BASE, idToken: 'id-secret-1', accessExp: T0_SECONDS + 10 });
    jar.values.set(SESSION_COOKIE, id);
    vi.mocked(refreshTokens).mockResolvedValue({
      accessToken: 'access-2',
      idToken: 'id-secret-2',
      accessExp: T0_SECONDS + 300,
    });
    expect(await getSession()).not.toHaveProperty('idToken');
    expect(await stored(id)).toHaveProperty('idToken', 'id-secret-2');
  });

  it('keeps the old ID token when the refresh sends none', async () => {
    const id = await createSession({ ...BASE, idToken: 'id-secret-1', accessExp: T0_SECONDS + 10 });
    jar.values.set(SESSION_COOKIE, id);
    vi.mocked(refreshTokens).mockResolvedValue({
      accessToken: 'access-2',
      accessExp: T0_SECONDS + 300,
    });
    expect(await getSession()).not.toHaveProperty('idToken');
    expect(await stored(id)).toHaveProperty('idToken', 'id-secret-1');
  });

  it('does not refresh with 60 s or more left', async () => {
    await signedIn({ accessExp: T0_SECONDS + 60 });
    expect(await getSession()).not.toBeNull();
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('destroys the session and returns null when the refresh fails', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 10 });
    vi.mocked(refreshTokens).mockRejectedValue(new Error('invalid_grant'));
    expect(await getSession()).toBeNull();
    expect(await stored(id)).toBeNull();
  });

  it('rejects a failed provider refresh even if deleting the record fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await signedIn({ accessExp: T0_SECONDS + 10 });
    vi.mocked(refreshTokens).mockRejectedValue(new Error('invalid_grant'));
    vi.spyOn(redis, 'del').mockRejectedValue(new Error('Command timed out'));
    await expect(getSession()).resolves.toBeNull();
    expect(refreshTokens).toHaveBeenCalledTimes(1);
  });

  it('destroys the session when the token is due and there is no refresh token', async () => {
    const id = await createSession({
      sub: BASE.sub,
      orgId: BASE.orgId,
      orgKind: BASE.orgKind,
      roles: BASE.roles,
      accessToken: BASE.accessToken,
      accessExp: T0_SECONDS + 10,
    });
    jar.values.set(SESSION_COOKIE, id);
    expect(await getSession()).toBeNull();
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(await stored(id)).toBeNull();
  });

  it('does not spend the refresh token twice while another request holds the lock', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 30 });
    // Long enough to still be held after the clock moves on below.
    await redis.set(`${keyFor(id)}:refresh`, 'other-request', 'PX', 60_000);

    // Token still valid for 30 s: keep using it.
    expect(await getSession()).toMatchObject({ accessToken: 'access-1' });
    // Token already expired: no session, but it is not destroyed (the lock holder decides).
    advance(31);
    expect(await getSession()).toBeNull();
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(await stored(id)).not.toBeNull();
  });

  it('uses a refresh another request already finished instead of refreshing again', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 30 });
    const realGet = redis.get.bind(redis);
    // Another request completes its refresh right after our first read.
    vi.spyOn(redis, 'get').mockImplementationOnce(async (key: RedisKey) => {
      const value = await realGet(key);
      const plain = openSessionValue(value as string, keyFor(id), RING) as string;
      const record = JSON.parse(plain) as Record<string, unknown>;
      const next = { ...record, accessToken: 'access-9', accessExp: T0_SECONDS + 300 };
      await redis.set(key, sealSessionValue(JSON.stringify(next), keyFor(id), RING));
      return value;
    });
    expect(await getSession()).toMatchObject({ accessToken: 'access-9' });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(await stored(id)).toMatchObject({ accessToken: 'access-9' });
  });
});

// CR-03 and the demo logout: a store failure is not a sign-out. When the read cannot be answered
// getSession throws SessionUnavailableError (callers show a retry, the cookie and record stay);
// once the read has proved the session valid, a failed write keeps the user signed in.
describe('getSession when Valkey errors', () => {
  /** Shaped like an ioredis ReplyError, which carries the command and its arguments. */
  function replyError(args: unknown[]): Error {
    return Object.assign(new Error('OOM command not allowed when used memory > maxmemory'), {
      name: 'ReplyError',
      command: { name: 'eval', args },
    });
  }

  /** The parsed JSON of every console.warn line. */
  function warned(warn: { mock: { calls: unknown[][] } }): Record<string, unknown>[] {
    return warn.mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
  }

  it('is unavailable, not signed out, when the read rejects twice, and keeps the record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn();
    const get = vi.spyOn(redis, 'get').mockRejectedValue(new Error('connect ECONNREFUSED'));
    await expect(getSession()).rejects.toBeInstanceOf(SessionUnavailableError);
    // One readiness-aware retry, no more.
    expect(get).toHaveBeenCalledTimes(2);
    get.mockRestore();
    expect(await stored(id)).not.toBeNull();
    expect(jar.store.set).not.toHaveBeenCalled();
    expect(warned(warn)).toEqual([
      {
        event: 'session.valkey_error',
        stage: 'read',
        outcome: 'unavailable',
        elapsedMs: expect.any(Number) as number,
        clientStatus: expect.any(String) as string,
        category: 'connection',
      },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(keyFor(id));
  });

  it('retries the read once and returns the session when the retry answers', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn();
    vi.spyOn(redis, 'get').mockRejectedValueOnce(new Error('Connection is closed.'));
    await expect(getSession()).resolves.toMatchObject({ id, sub: 'user-1' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the session when the sliding write rejects, and never logs the record', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn();
    advance(120); // past the 60 s window in which a read does not write
    const raw = await redis.get(keyFor(id));
    vi.spyOn(redis, 'eval').mockRejectedValue(replyError([keyFor(id), raw]));
    await expect(getSession()).resolves.toMatchObject({ id, sub: 'user-1', roles: ['founder'] });
    expect(warned(warn)).toMatchObject([{ stage: 'slide', outcome: 'kept', category: 'other' }]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of [BASE.accessToken, BASE.refreshToken, id, keyFor(id)]) {
      expect(logged).not.toContain(secret);
    }
  });

  it('keeps the current token when the refresh path rejects while it is still valid', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn({ accessExp: T0_SECONDS + 10 });
    vi.spyOn(redis, 'set').mockRejectedValue(replyError([]));
    await expect(getSession()).resolves.toMatchObject({ id, accessToken: 'access-1' });
    expect(refreshTokens).not.toHaveBeenCalled();
    expect(warned(warn)).toMatchObject([{ stage: 'rotate', outcome: 'kept' }]);
  });

  it('stores the rotated tokens when the first write after a refresh rejects', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn({ accessExp: T0_SECONDS + 10 });
    vi.mocked(refreshTokens).mockResolvedValue({
      accessToken: 'access-2',
      refreshToken: 'refresh-2',
      accessExp: T0_SECONDS + 300,
    });
    const realSet = redis.set.bind(redis) as unknown as (...args: unknown[]) => Promise<unknown>;
    let writes = 0;
    // The lock (NX) goes through; the first write of the refreshed record (XX) drops.
    vi.spyOn(redis, 'set').mockImplementation((async (...args: unknown[]) => {
      if (args.includes('XX') && writes++ === 0) throw new Error('Connection is closed.');
      return realSet(...args);
    }) as unknown as typeof redis.set);

    await expect(getSession()).resolves.toMatchObject({ id, accessToken: 'access-2' });
    vi.mocked(redis.set).mockRestore();
    expect(refreshTokens).toHaveBeenCalledTimes(1);
    // The spent refresh token is not left in the store.
    expect(await stored(id)).toMatchObject({ accessToken: 'access-2', refreshToken: 'refresh-2' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('is unavailable when the refresh path rejects and the token has expired', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn({ accessExp: T0_SECONDS - 5 });
    vi.spyOn(redis, 'set').mockRejectedValue(replyError([]));
    await expect(getSession()).rejects.toBeInstanceOf(SessionUnavailableError);
    expect(refreshTokens).not.toHaveBeenCalled();
    vi.mocked(redis.set).mockRestore();
    expect(await stored(id)).not.toBeNull();
  });

  it('still signs out a corrupt record whose delete fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = await signedIn();
    await redis.set(keyFor(id), 'not an envelope');
    vi.spyOn(redis, 'del').mockRejectedValue(new Error('Command timed out'));
    await expect(getSession()).resolves.toBeNull();
    expect(warned(warn).filter((line) => line.event === 'session.valkey_error')).toMatchObject([
      { stage: 'cleanup', outcome: 'signed_out', category: 'timeout' },
    ]);
  });
});

describe('peekSession', () => {
  it('returns the ID token of a live record without sliding its TTL or lastSeenAt', async () => {
    const id = await createSession({ ...BASE, idToken: 'id-secret-1' });
    advance(100);
    expect(await peekSession(id)).toEqual({ idToken: 'id-secret-1' });
    expect(await redis.ttl(keyFor(id))).toBe(IDLE_SECONDS - 100);
    expect(await stored(id)).toHaveProperty('lastSeenAt', T0_SECONDS);
  });

  it('returns a record with no idToken when none was stored', async () => {
    const id = await createSession(BASE);
    expect(await peekSession(id)).toEqual({});
  });

  it('never refreshes, even when the access token is about to expire', async () => {
    const id = await createSession({ ...BASE, idToken: 'id-secret-1', accessExp: T0_SECONDS + 5 });
    expect(await peekSession(id)).toEqual({ idToken: 'id-secret-1' });
    expect(refreshTokens).not.toHaveBeenCalled();
  });

  it('is null for an idle-expired record and does not delete it', async () => {
    const id = await createSession({ ...BASE, idToken: 'id-secret-1' });
    // Rewrite the record as idle for too long, but keep the key alive.
    const old = { ...BASE, idToken: 'id-secret-1', createdAt: T0_SECONDS, lastSeenAt: T0_SECONDS };
    advance(IDLE_SECONDS + 1);
    await redis.set(keyFor(id), sealSessionValue(JSON.stringify(old), keyFor(id), RING));
    expect(await peekSession(id)).toBeNull();
    expect(await redis.exists(keyFor(id))).toBe(1);
  });

  it('is null for a missing record, a malformed id and a value that does not decrypt', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(await peekSession('A'.repeat(43))).toBeNull();
    expect(await peekSession('not-an-id')).toBeNull();
    const id = await createSession(BASE);
    await redis.set(keyFor(id), 'garbage');
    expect(await peekSession(id)).toBeNull();
  });
});

describe('destroySession', () => {
  it('deletes the record', async () => {
    const id = await signedIn();
    await destroySession(id);
    expect(await redis.exists(keyFor(id))).toBe(0);
    expect(await getSession()).toBeNull();
  });
});

// CR-13: Valkey's AOF writes every value to disk, and KEYS/SCAN or a dump shows every key.
describe('sessions at rest', () => {
  it('never uses the raw session id as or inside a Valkey key', async () => {
    const id = await signedIn({ accessExp: T0_SECONDS + 10 });
    const keysDuringRefresh: string[] = [];
    vi.mocked(refreshTokens).mockImplementation(async () => {
      keysDuringRefresh.push(...(await redis.keys('*'))); // the refresh lock exists only now
      return { accessToken: 'access-2', refreshToken: 'refresh-2', accessExp: T0_SECONDS + 300 };
    });
    expect(await getSession()).not.toBeNull();
    const keys = [...keysDuringRefresh, ...(await redis.keys('*'))];
    expect(keys).toContain(keyFor(id));
    expect(keys).toContain(`${keyFor(id)}:refresh`);
    for (const key of keys) {
      expect(key).toMatch(/^ws:sess:[0-9a-f]{64}(:refresh)?$/);
      expect(key).not.toContain(id);
    }
  });

  it('stores an AES-GCM envelope that contains no token text', async () => {
    const id = await signedIn();
    const raw = (await redis.get(keyFor(id))) as string;
    expect(raw).toMatch(/^v1\.k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{22}$/);
    for (const secret of [BASE.accessToken, BASE.refreshToken, BASE.sub, id]) {
      expect(raw).not.toContain(secret);
    }
  });

  it('rejects a value copied from another session key', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const victim = await createSession({ ...BASE, sub: 'victim' });
    const attacker = await signedIn({ sub: 'attacker' });
    await redis.set(keyFor(attacker), (await redis.get(keyFor(victim))) as string);
    expect(await getSession()).toBeNull();
    expect(await redis.exists(keyFor(attacker))).toBe(0);
  });

  it('treats a session in the old plaintext format as signed out', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const id = 'B'.repeat(43);
    const legacy = JSON.stringify({ ...BASE, createdAt: T0_SECONDS, lastSeenAt: T0_SECONDS });
    await redis.set(`ws:sess:${id}`, legacy); // the old key: the raw id
    await redis.set(keyFor(id), legacy); // and plaintext under the new key
    jar.values.set(SESSION_COOKIE, id);
    expect(await getSession()).toBeNull();
    expect(await redis.exists(keyFor(id))).toBe(0);
    // Only an event name is logged: no id, key or value.
    expect(warn.mock.calls).toEqual([[JSON.stringify({ event: 'session.decrypt_failed' })]]);
  });

  it('cannot read a session after the key id changes to one it was not sealed with', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    await signedIn();
    vi.stubEnv('SESSION_ENC_KEY_ID', 'k2');
    __resetEnvForTests();
    expect(await getSession()).toBeNull();
  });
});

describe('Valkey client', () => {
  it('fails fast in an outage: command timeout, no offline queue, one retry', () => {
    __setRedisForTests(undefined);
    const client = getRedis();
    try {
      expect(client.options).toMatchObject({
        host: 'valkey.test',
        commandTimeout: 1000,
        enableOfflineQueue: false,
        maxRetriesPerRequest: 1,
      });
    } finally {
      client.disconnect();
    }
  });

  it('waits for a connecting client to be ready instead of failing the first command', async () => {
    // Without the offline queue, ioredis rejects a command sent before the connection is ready.
    // A plain emitter stands in for the client: ioredis-mock emits its own late 'ready'.
    const get = vi.fn().mockResolvedValue(null);
    const cold = Object.assign(new EventEmitter(), { status: 'connecting', get });
    __setRedisForTests(cold as unknown as Redis);
    jar.values.set(SESSION_COOKIE, 'C'.repeat(43));
    const pending = getSession();
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(get).not.toHaveBeenCalled();
    cold.status = 'ready';
    cold.emit('ready');
    expect(await pending).toBeNull();
    expect(get).toHaveBeenCalledWith(keyFor('C'.repeat(43)));
  });
});

describe('safeReturnTo', () => {
  it.each([
    ['/'],
    ['/dashboard'],
    ['/orders/42?tab=open&sort=-date'],
    ['/a/b#section'],
    ['/search?q=a%20b'],
    ['/files/a%2Fb'],
  ])('accepts the local path %s', (path) => {
    expect(safeReturnTo(path)).toBe(path);
  });

  it.each([
    [null],
    [undefined],
    [''],
    ['dashboard'],
    ['//evil.example'],
    ['///evil.example'],
    ['/\\evil.example'],
    ['\\\\evil.example'],
    ['/foo\\bar'],
    ['https://evil.example/'],
    ['http:/evil.example'],
    ['javascript:alert(1)'],
    ['JaVaScRiPt:alert(1)'],
    ['data:text/html,x'],
    ['/%2f%2fevil.example'],
    ['/%2F%2Fevil.example'],
    ['/%5cevil.example'],
    ['/%5Cevil.example'],
    ['/%252f%252fevil.example'],
    ['%2f%2fevil.example'],
    ['/\t/evil.example'],
    ['/\n/evil.example'],
    ['/\r\n/evil.example'],
    ['/%09/evil.example'],
    ['/%0d%0aSet-Cookie:x=1'],
    ['/a\u0000b'],
    ['/a\u007fb'],
    ['/a/..//evil.example'],
    ['/%2e%2e//evil.example'],
    ['/.%2e/%2fevil.example'],
    ['/%2e%2e/%2fevil.example'],
    ['/a/../%5cevil.example'],
    ['/%E0%A4%A'],
    ['/' + 'a'.repeat(2048)],
  ])('rejects %j', (raw) => {
    expect(safeReturnTo(raw)).toBe('/');
  });
});
