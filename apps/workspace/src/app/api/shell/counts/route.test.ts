import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/headers', () => ({ cookies: vi.fn() }));
vi.mock('@/lib/oidc', () => ({ refreshTokens: vi.fn() }));

// Only the cookie lookup is replaced; the real API client reads both counts through a stubbed fetch.
const getSession = vi.fn<(options?: { slide?: boolean }) => Promise<Session | null>>();
vi.mock('@/lib/session', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/session')>()),
  getSession: (options?: { slide?: boolean }) => getSession(options),
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

const INBOX_COUNT = '/v1/approvals/inbox/count';
const UNREAD_COUNT = '/v1/notifications/unread-count';

const fetchMock = vi.fn<(input: URL, init?: RequestInit) => Promise<Response>>();

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const count = (n: number) => json(200, { count: n });
const refused = (status: number, code: string) =>
  json(status, { error: { code, message: 'Refused' } });

/** Answers each API path with a fresh response, so the two reads can succeed or fail independently. */
function api(answers: Record<string, () => Response>) {
  fetchMock.mockImplementation((url) => {
    const answer = answers[url.pathname];
    return Promise.resolve(answer ? answer() : json(404, { error: { message: 'Not found' } }));
  });
}

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

describe('GET /api/shell/counts', () => {
  it('reads the session without sliding it: the badge poll must not keep a tab signed in', async () => {
    api({ [INBOX_COUNT]: () => count(1), [UNREAD_COUNT]: () => count(1) });
    await GET();
    expect(getSession).toHaveBeenCalledWith({ slide: false });
  });

  it('returns both counts, read as the signed-in user', async () => {
    api({ [INBOX_COUNT]: () => count(4), [UNREAD_COUNT]: () => count(2) });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inbox: 4, notifications: 2 });
    const calls = fetchMock.mock.calls.map(([url, init]) => ({
      href: url.href,
      auth: new Headers(init?.headers).get('authorization'),
    }));
    expect(calls).toHaveLength(2);
    expect(calls).toEqual(
      expect.arrayContaining([
        { href: `http://api:3001${INBOX_COUNT}`, auth: 'Bearer token' },
        { href: `http://api:3001${UNREAD_COUNT}`, auth: 'Bearer token' },
      ]),
    );
  });

  it('keeps zero counts as zeros', async () => {
    api({ [INBOX_COUNT]: () => count(0), [UNREAD_COUNT]: () => count(0) });

    const res = await GET();

    expect(await res.json()).toEqual({ inbox: 0, notifications: 0 });
  });

  it("leaves the inbox unknown for a non-approver's 403 and still returns the unread count", async () => {
    api({
      [INBOX_COUNT]: () => refused(403, 'out_of_scope'),
      [UNREAD_COUNT]: () => count(3),
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inbox: null, notifications: 3 });
  });

  it('leaves the unread count unknown, not zero, when that read fails', async () => {
    api({
      [INBOX_COUNT]: () => count(5),
      [UNREAD_COUNT]: () => json(500, { error: { message: 'Boom' } }),
    });

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inbox: 5, notifications: null });
  });

  it('treats a count body that breaks the contract as unknown', async () => {
    api({
      [INBOX_COUNT]: () => json(200, { count: -1 }),
      [UNREAD_COUNT]: () => json(200, { total: 1 }),
    });

    const res = await GET();

    expect(await res.json()).toEqual({ inbox: null, notifications: null });
  });

  it('leaves both counts unknown when the API does not answer', async () => {
    fetchMock.mockRejectedValue(new TypeError('fetch failed'));

    const res = await GET();

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ inbox: null, notifications: null });
  });

  it('asks for sign-in without a session and never calls the API', async () => {
    getSession.mockResolvedValue(null);

    const res = await GET();

    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('asks for sign-in when the API rejects the token on either read', async () => {
    api({
      [INBOX_COUNT]: () => count(1),
      [UNREAD_COUNT]: () => refused(401, 'unauthorized'),
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('notifications');
  });

  it('asks for sign-in when the API rejects the token on the inbox read', async () => {
    api({
      [INBOX_COUNT]: () => refused(401, 'unauthorized'),
      [UNREAD_COUNT]: () => count(1),
    });

    const res = await GET();

    expect(res.status).toBe(401);
    expect(await res.json()).not.toHaveProperty('inbox');
  });
});
