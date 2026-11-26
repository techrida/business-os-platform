import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createHash } from 'node:crypto';
import net from 'node:net';

import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import AppLayout from '../app/(app)/layout';
import { POST } from '../app/telemetry/vitals/route';
import { __resetEnvForTests } from './env';
import {
  __setRedisForTests,
  createSession,
  getRedis,
  getSession,
  SESSION_COOKIE,
  VALKEY_CLIENT_OPTIONS,
} from './session';
import { SessionUnavailableError } from './session-unavailable';

/**
 * The demo logout, reproduced against a real Valkey with the production ioredis options: a
 * session read whose connection drops, with the reconnect held past the deadline, must answer
 * "unavailable" (no login redirect, no cookie change, no protected content), and the same cookie
 * must work once Valkey is back. A small TCP proxy between the client and Valkey drops the
 * connection on a chosen command and holds new connections until released.
 *
 * Needs Docker: it starts a throwaway Valkey (the image pinned in infra/compose) on a random
 * loopback port and removes it afterwards. Set BOS_TEST_VALKEY_URL to use an existing disposable
 * server instead. Without either the suite is skipped.
 */

vi.mock('server-only', () => ({}));
vi.mock('./oidc', () => ({ refreshTokens: vi.fn() }));
vi.mock('next/navigation', () => ({
  // The real `redirect` throws; so does this, with the target in the message.
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
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
      set: vi.fn((name: string, value: string) => {
        values.set(name, value);
      }),
    },
  };
});
vi.mock('next/headers', () => ({ cookies: vi.fn(() => Promise.resolve(jar.store)) }));

const VALKEY_IMAGE =
  'valkey/valkey:9.1-alpine@sha256:bf09d58e96d6b4524a15396b65b242bbe18beebbcc15a04d8ee75ddac62fae0b';

const presetUrl = process.env.BOS_TEST_VALKEY_URL;
const dockerUp = !presetUrl && spawnSync('docker', ['info'], { stdio: 'ignore' }).status === 0;
const enabled = Boolean(presetUrl) || dockerUp;
if (!enabled) console.warn('session.valkey.test: no Docker and no BOS_TEST_VALKEY_URL; skipped');

const BASE = {
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff' as const,
  roles: ['founder'],
  accessToken: 'access-1',
  refreshToken: 'refresh-1',
  accessExp: Math.floor(Date.now() / 1000) + 30 * 86400,
};

const keyFor = (id: string) => `ws:sess:${createHash('sha256').update(id).digest('hex')}`;

/**
 * Forwards TCP to Valkey. `dropOn(pattern)`: when a client sends a command matching `pattern`,
 * every connection is cut before the command reaches Valkey and new connections are accepted but
 * held (nothing forwarded, so the client never becomes ready). `restore()` resumes forwarding,
 * including the held connections.
 */
class ChaosProxy {
  private readonly server: net.Server;
  private readonly live = new Set<net.Socket>();
  private held: net.Socket[] = [];
  private holding = false;
  private trigger: RegExp | null = null;
  port = 0;

  constructor(
    private readonly upstreamHost: string,
    private readonly upstreamPort: number,
  ) {
    this.server = net.createServer((socket) => {
      socket.on('error', () => undefined);
      if (this.holding) {
        socket.pause();
        this.held.push(socket);
      } else {
        this.forward(socket);
      }
    });
  }

  async listen(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as net.AddressInfo).port;
  }

  dropOn(pattern: RegExp): void {
    this.trigger = pattern;
  }

  restore(): void {
    this.holding = false;
    this.trigger = null;
    const held = this.held;
    this.held = [];
    for (const socket of held) if (!socket.destroyed) this.forward(socket);
  }

  async close(): Promise<void> {
    for (const socket of [...this.live, ...this.held]) socket.destroy();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private forward(client: net.Socket): void {
    const upstream = net.connect(this.upstreamPort, this.upstreamHost);
    upstream.on('error', () => undefined);
    this.live.add(client);
    this.live.add(upstream);
    const cut = () => {
      client.destroy();
      upstream.destroy();
      this.live.delete(client);
      this.live.delete(upstream);
    };
    client.on('data', (chunk: Buffer) => {
      if (this.trigger?.test(chunk.toString('latin1'))) {
        this.trigger = null;
        this.holding = true;
        for (const socket of [...this.live]) socket.destroy();
        this.live.clear();
        return;
      }
      upstream.write(chunk);
    });
    upstream.on('data', (chunk: Buffer) => client.write(chunk));
    client.on('close', cut);
    upstream.on('close', cut);
    client.resume();
  }
}

/** Resolves once the client is ready (it reconnects by itself after the proxy is restored). */
async function untilReady(client: Redis, timeoutMs = 10_000): Promise<void> {
  if (client.status === 'ready') return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`still ${client.status}`)), timeoutMs);
    client.once('ready', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

let containerName: string | undefined;
let valkeyHost = '127.0.0.1';
let valkeyPort = 0;
let direct: Redis;
let proxy: ChaosProxy;

beforeAll(async () => {
  if (!enabled) return;
  if (presetUrl) {
    const url = new URL(presetUrl);
    valkeyHost = url.hostname;
    valkeyPort = Number(url.port || 6379);
  } else {
    containerName = `bos-ws-session-test-${randomBytes(4).toString('hex')}`;
    // `127.0.0.1::6379` lets Docker pick a free loopback port, so this never collides with a
    // running stack (6379/6380 stay untouched).
    execFileSync('docker', [
      'run',
      '--rm',
      '-d',
      '--name',
      containerName,
      '-p',
      '127.0.0.1::6379',
      VALKEY_IMAGE,
    ]);
    const mapped = execFileSync('docker', ['port', containerName, '6379/tcp'], {
      encoding: 'utf8',
    });
    valkeyPort = Number(/:(\d+)\s*$/m.exec(mapped)?.[1]);
  }
  direct = new Redis({ host: valkeyHost, port: valkeyPort, maxRetriesPerRequest: 3 });
  for (let i = 0; i < 50; i++) {
    try {
      if ((await direct.ping()) === 'PONG') break;
    } catch {
      // still starting
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}, 60_000);

afterAll(() => {
  direct?.disconnect();
  if (containerName) spawnSync('docker', ['rm', '-f', containerName], { stdio: 'ignore' });
});

beforeEach(async () => {
  if (!enabled) return;
  proxy = new ChaosProxy(valkeyHost, valkeyPort);
  await proxy.listen();
  for (const [k, v] of Object.entries({
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    API_INTERNAL_URL: 'http://api:3001',
    VALKEY_URL: `redis://127.0.0.1:${proxy.port}`,
    SESSION_ENC_KEY: Buffer.alloc(32, 9).toString('base64'),
    SESSION_ENC_KEY_ID: 'k1',
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  __setRedisForTests(undefined); // the real client, built by getRedis() from VALKEY_URL
  jar.values.clear();
  jar.store.set.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  if (!enabled) return;
  getRedis().disconnect();
  __setRedisForTests(undefined);
  await proxy.close();
  vi.unstubAllEnvs();
  __resetEnvForTests();
  vi.restoreAllMocks();
});

/** Signs in for real (through the proxy) and returns the cookie id. */
async function signedIn(): Promise<string> {
  const id = await createSession(BASE);
  jar.values.set(SESSION_COOKIE, id);
  jar.store.set.mockClear();
  // Warm the connection the way a live server has one: the next read uses this socket.
  await expect(getSession()).resolves.toMatchObject({ id });
  return id;
}

describe.skipIf(!enabled)('getSession against a real Valkey that drops the connection', () => {
  it('uses the production client options', () => {
    expect(getRedis().options).toMatchObject(VALKEY_CLIENT_OPTIONS);
  });

  it('answers unavailable, not login, when the read connection drops and reconnect is held', async () => {
    const id = await signedIn();
    proxy.dropOn(/\r\nget\r\n/i);

    const started = performance.now();
    // A page guard: no redirect to /auth/login, and no session handed to the page.
    await expect(AppLayout({ children: null })).rejects.toBeInstanceOf(SessionUnavailableError);
    // Bounded by the read deadline (2 s) plus scheduling slack.
    expect(performance.now() - started).toBeLessThan(3500);

    // One structured line: where, how long, what kind; nothing from the error itself.
    // The client's own `error` events (dropped connection, refused reconnect) log one more line each, by
    // error name only; they are not this request's line, so they are set aside.
    const allLines = vi
      .mocked(console.warn)
      .mock.calls.map((call) => JSON.parse(String(call[0])) as Record<string, unknown>);
    const clientErrors = allLines.filter((l) => l.event === 'valkey.client_error');
    for (const line of clientErrors) {
      expect(Object.keys(line).sort()).toEqual(['client', 'error', 'event']);
    }
    const lines = allLines.filter((l) => l.event !== 'valkey.client_error');
    expect(lines).toEqual([
      expect.objectContaining({
        event: 'session.valkey_error',
        stage: 'read',
        outcome: 'unavailable',
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain(keyFor(id));

    // A Route Handler: a retryable 503, not a 401.
    const res = await POST(new Request('https://app.test/telemetry/vitals', { method: 'POST' }));
    expect(res.status).toBe(503);

    // The cookie was never touched and the record is still there.
    expect(jar.store.set).not.toHaveBeenCalled();
    expect(await direct.exists(keyFor(id))).toBe(1);

    // Valkey is reachable again: the very same cookie works.
    proxy.restore();
    await untilReady(getRedis());
    await expect(getSession()).resolves.toMatchObject({ id, sub: 'user-1' });
    await expect(AppLayout({ children: null })).resolves.toBeDefined();
  }, 20_000);

  it('requires login when the record was deleted while Valkey was unreachable', async () => {
    const id = await signedIn();
    proxy.dropOn(/\r\nget\r\n/i);
    await expect(getSession()).rejects.toBeInstanceOf(SessionUnavailableError);

    await direct.del(keyFor(id));
    proxy.restore();
    await untilReady(getRedis());

    await expect(getSession()).resolves.toBeNull();
    await expect(AppLayout({ children: null })).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2F',
    );
  }, 20_000);

  it('keeps the session valid when the sliding write fails after a good read', async () => {
    const id = await signedIn();
    proxy.dropOn(/\r\neval\r\n/i);

    await expect(getSession()).resolves.toMatchObject({ id, sub: 'user-1', roles: ['founder'] });
    expect(jar.store.set).not.toHaveBeenCalled();
    expect(await direct.exists(keyFor(id))).toBe(1);
    proxy.restore();
  }, 20_000);
});
