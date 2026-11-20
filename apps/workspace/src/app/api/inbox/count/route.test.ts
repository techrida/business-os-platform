import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/oidc', () => ({ refreshTokens: vi.fn() }));

// Only the cookie lookup is replaced; the real API client reads the inbox through a stubbed fetch.
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getSession: () => getSession(),
}));

const { GET } = await import('./route');

const STAFF: Session = {
  id: 'A'.repeat(43),
  sub: 'approver',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  roles: ['finance'],
  accessToken: 'token',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

const fetchMock = vi.fn<(input: URL, init?: RequestInit) => Promise<Response>>();

/** What the API's `GET /v1/approvals/inbox` sends: a page of items and the total in a header. */
const inbox = (total: number) =>
  new Response('[]', {
    status: 200,
    headers: { 'content-type': 'application/json', 'x-total-count': String(total) },
  });

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'c',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'p',
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://v:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  getSession.mockReset();
  getSession.mockResolvedValue(STAFF);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('GET /api/inbox/count', () => {
  it('returns the inbox total, reading one row as the signed-in user', async () => {
    fetchMock.mockResolvedValue(inbox(7));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ count: 7 });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url.href).toBe('http://api:3001/v1/approvals/inbox?limit=1');
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer token');
  });

  it('asks for sign-in without a session and never calls the API', async () => {
    getSession.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a refused read an error, never a zero', async () => {
    fetchMock.mockResolvedValue(
      new Response('{"error":{"message":"Forbidden"}}', {
        status: 403,
        headers: { 'content-type': 'application/json' },
      }),
    );

    const res = await GET();

    expect(res.status).toBe(403);
    expect(await res.json()).not.toHaveProperty('count');
  });

  it('turns an inbox page without a total into a gateway error', async () => {
    fetchMock.mockResolvedValue(new Response('[]', { status: 200 }));

    const res = await GET();

    expect(res.status).toBe(502);
    expect(await res.json()).not.toHaveProperty('count');
  });
});
