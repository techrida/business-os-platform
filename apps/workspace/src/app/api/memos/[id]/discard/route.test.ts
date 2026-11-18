import { createRequire } from 'node:module';

import type { Redis } from 'ioredis';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __setRedisForTests, type Session } from '@/lib/session';

const RedisMock = createRequire(import.meta.url)('ioredis-mock') as new () => Redis;

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock('@/lib/oidc', () => ({ refreshTokens: vi.fn() }));

const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getSession: () => getSession(),
}));

// The real ApiError and failure wording run; only the network call to the API is scripted.
const apiFetch = vi.fn<(session: Session, path: string, init?: RequestInit) => Promise<Response>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: (session: Session, path: string, init?: RequestInit) => apiFetch(session, path, init),
}));

const { __resetEnvForTests } = await import('@/lib/env');
const { POST } = await import('./route');
const { memoDraftAccount } = await import('@/lib/memo-working-draft');

const ORIGIN = 'https://app.test';
const MEMO = '22222222-2222-4222-8222-222222222222';
const session: Session = {
  id: 'A'.repeat(43),
  sub: 'alice',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'token',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

const discard = (
  id = MEMO,
  origin: string | null = ORIGIN,
  account: string | null = memoDraftAccount(session),
) => {
  const headers: Record<string, string> = {};
  if (origin !== null) headers.origin = origin;
  if (account !== null) headers['x-bos-draft-account'] = account;
  return POST(new Request(`${ORIGIN}/api/memos/${id}/discard`, { method: 'POST', headers }), {
    params: Promise.resolve({ id }),
  });
};

const apiError = (status: number, code: string, reason?: string) =>
  new Response(JSON.stringify({ error: { code, message: 'x', ...(reason ? { reason } : {}) } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'c',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'p',
    WORKSPACE_PUBLIC_URL: ORIGIN,
    VALKEY_URL: 'redis://v:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  __setRedisForTests(new RedisMock());
  getSession.mockReset();
  getSession.mockResolvedValue(session);
  apiFetch.mockReset();
});

afterEach(() => {
  __setRedisForTests(undefined);
  vi.unstubAllEnvs();
  __resetEnvForTests();
});

describe('POST /api/memos/:id/discard', () => {
  it('discards through the API as the signed-in user: no payload, 204 and nothing else', async () => {
    apiFetch.mockResolvedValue(new Response(null, { status: 204 }));
    const res = await discard();
    expect(res.status).toBe(204);
    expect(await res.text()).toBe('');
    expect(apiFetch).toHaveBeenCalledTimes(1);
    const [calledSession, path, init] = apiFetch.mock.calls[0]!;
    expect(calledSession).toBe(session);
    expect(path).toBe(`/v1/test-memos/${MEMO}/discard`);
    expect(init).toEqual({ method: 'POST' });
  });

  it('refuses a request that did not come from the workspace origin, before any API call', async () => {
    expect((await discard(MEMO, 'https://evil.test')).status).toBe(403);
    expect((await discard(MEMO, null)).status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses a tab opened under another account, or one that sent no account, before any API call', async () => {
    const other = { ...session, sub: 'bob' };
    expect((await discard(MEMO, ORIGIN, memoDraftAccount(other))).status).toBe(403);
    expect((await discard(MEMO, ORIGIN, null)).status).toBe(403);
    expect((await discard(MEMO, ORIGIN, 'forged')).status).toBe(403);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it('refuses without a staff session and for a value that is not a memo id', async () => {
    getSession.mockResolvedValue(null);
    expect((await discard()).status).toBe(401);
    getSession.mockResolvedValue(session);
    expect((await discard('not-a-uuid')).status).toBe(400);
    expect(apiFetch).not.toHaveBeenCalled();
  });

  it.each([
    [404, 'not_found'],
    [403, 'forbidden'],
    [409, 'conflict'],
  ])('passes the API answer %i through as an error the browser can show', async (status, code) => {
    apiFetch.mockResolvedValue(apiError(status, code, status === 403 ? 'not_creator' : undefined));
    const res = await discard();
    expect(res.status).toBe(status);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/\S/);
  });

  it('answers 502 when the API is down, never success', async () => {
    apiFetch.mockRejectedValue(new TypeError('fetch failed'));
    expect((await discard()).status).toBe(502);
  });
});
