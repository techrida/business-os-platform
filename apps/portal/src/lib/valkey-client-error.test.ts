import { EventEmitter } from 'node:events';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from './env';
import { __resetOidcForTests, __setOidcRedisForTests, getOidcRedis } from './oidc';
import { __setRedisForTests, getRedis } from './session';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));

// A stand-in for the ioredis client: an emitter that records how it was built.
const clients = vi.hoisted(() => [] as unknown[]);
vi.mock('ioredis', async () => {
  const { EventEmitter: Emitter } = await import('node:events');
  class FakeRedis extends Emitter {
    status = 'wait';
    constructor(readonly url: string) {
      super();
      clients.push(this);
    }
  }
  return { Redis: FakeRedis };
});

const ENV = {
  OIDC_ISSUER: 'https://auth.test',
  OIDC_CLIENT_ID: 'client-123',
  OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
  OIDC_AUDIENCE: 'proj-42',
  WORKSPACE_PUBLIC_URL: 'https://app.test',
  PORTAL_PUBLIC_URL: 'https://app.test',
  API_INTERNAL_URL: 'http://api:3001',
  VALKEY_URL: 'redis://valkey.test:6379',
  OIDC_STATE_VALKEY_URL: 'redis://valkey-oidc.test:6379',
  SESSION_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
  SESSION_ENC_KEY_ID: 'k1',
};

beforeEach(() => {
  for (const [k, v] of Object.entries(ENV)) vi.stubEnv(k, v);
  __resetEnvForTests();
  __setRedisForTests(undefined);
  __setOidcRedisForTests(undefined);
  __resetOidcForTests();
  clients.length = 0;
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

/** An ioredis-style error: the message carries the command arguments, here a key and a token. */
function leakyError(): Error {
  const err = new Error('ERR set pt:sess:abc123 {"accessToken":"secret-access-token"}');
  err.name = 'ReplyError';
  return err;
}

describe.each([
  ['session', () => getRedis(), 'redis://valkey.test:6379'],
  ['oidc', () => getOidcRedis(), 'redis://valkey-oidc.test:6379'],
] as const)('the %s Valkey client', (which, make, url) => {
  it('has an error listener, so ioredis does not print the raw error', () => {
    const client = make() as unknown as EventEmitter & { url: string };
    expect(client.url).toBe(url);
    expect(client.listenerCount('error')).toBeGreaterThan(0);
  });

  it('logs the error name only, never the message', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const client = make() as unknown as EventEmitter;

    client.emit('error', leakyError());

    expect(warn).toHaveBeenCalledTimes(1);
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line).toEqual({ event: 'valkey.client_error', client: which, error: 'ReplyError' });
    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain('secret-access-token');
    expect(logged).not.toContain('sess:abc123');
  });

  it('logs "unknown" for a value that is not an Error', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    (make() as unknown as EventEmitter).emit('error', 'secret string');
    const line = JSON.parse(String(warn.mock.calls[0]?.[0])) as Record<string, unknown>;
    expect(line.error).toBe('unknown');
    expect(JSON.stringify(warn.mock.calls)).not.toContain('secret string');
  });
});
