import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';
import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

// Only the session store is replaced: the real routeSession decides 401, 403 or 503.
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const fetchMock = vi.fn<typeof fetch>();

const { GET } = await import('./route');

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const VERSION_ID = '22222222-2222-4222-8222-222222222222';

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 'eyJ.secret-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

const download = () =>
  GET(new Request(`https://app.test/api/documents/${DOC_ID}/versions/${VERSION_ID}/download`), {
    params: Promise.resolve({ documentId: DOC_ID, versionId: VERSION_ID }),
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
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  __resetEnvForTests();
});

describe('GET /api/documents/:documentId/versions/:versionId/download session outcomes', () => {
  it('reports a session-store outage as retryable, not as "Staff only."', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await download();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.text()).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps the sign-in and staff-only refusals', async () => {
    getSession.mockResolvedValueOnce(null);
    const signedOut = await download();
    expect(signedOut.status).toBe(401);
    expect(await signedOut.text()).toBe('Sign in to download this file.');

    getSession.mockResolvedValueOnce({ ...staff, orgKind: 'customer' });
    const customer = await download();
    expect(customer.status).toBe(403);
    expect(await customer.text()).toBe('Staff only.');
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('GET /api/documents/:documentId/versions/:versionId/download busy API', () => {
  it('passes a db_busy 503 through with its wait, not a 502', async () => {
    getSession.mockResolvedValue(staff);
    fetchMock.mockResolvedValue(
      Response.json(
        {
          error: {
            code: 'db_busy',
            message: 'Busy, please try again',
            correlationId: 'c-1',
            details: { retryAfterSeconds: 2 },
          },
        },
        { status: 503, headers: { 'retry-after': '2' } },
      ),
    );
    const res = await download();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await res.text()).toBe('Busy, please try again.');
  });
});
