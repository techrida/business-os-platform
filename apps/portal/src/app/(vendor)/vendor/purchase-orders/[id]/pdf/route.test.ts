import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import { SessionUnavailableError, SESSION_UNAVAILABLE_MESSAGE } from '@/lib/session-unavailable';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { GET } = await import('./route');

const ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
const session: Session = {
  id: 'A'.repeat(43),
  sub: 'user-1',
  orgId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'vendor',
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'eyJ.secret-access-token.sig',
  accessExp: 2_000_000_000,
  createdAt: 1_700_000_000,
  lastSeenAt: 1_700_000_000,
};
const LINK = { url: '/v1/files/tok.abc-123', expiresAt: '2026-11-08T10:01:00+05:45' };

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const call = (id: string) =>
  GET(new Request(`https://app.test/vendor/purchase-orders/${id}/pdf`), {
    params: Promise.resolve({ id }),
  });

beforeEach(() => {
  for (const [k, v] of Object.entries({
    API_INTERNAL_URL: 'http://api:3001',
    OIDC_ISSUER: 'https://auth.test',
    OIDC_CLIENT_ID: 'client-123',
    OIDC_REDIRECT_URI: 'https://app.test/auth/callback',
    OIDC_AUDIENCE: 'proj-42',
    PORTAL_PUBLIC_URL: 'https://app.test',
    VALKEY_URL: 'redis://valkey.test:6379',
    SESSION_ENC_KEY: Buffer.alloc(32, 5).toString('base64'),
  })) {
    vi.stubEnv(k, v);
  }
  __resetEnvForTests();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('GET /vendor/purchase-orders/:id/pdf', () => {
  it('returns a retryable outage before querying the purchase order', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const response = await call(ID);
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('1');
    expect(await response.text()).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a session (401, plain text) and calls nothing', async () => {
    getSession.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a customer session with the plain 404 and calls nothing', async () => {
    getSession.mockResolvedValue({ ...session, orgKind: 'customer' });
    const res = await call(ID);
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('Purchase order not found.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a non-id, a 404 and a 403 with the same text and status', async () => {
    const bad = await call('not-an-id');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 404));
    const missing = await call(ID);
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 403));
    const forbidden = await call(ID);
    for (const res of [bad, missing, forbidden]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Purchase order not found.');
    }
  });

  it('streams the PDF with only the safe headers', async () => {
    fetchMock.mockResolvedValueOnce(json(LINK)).mockResolvedValueOnce(
      new Response('%PDF-1.7', {
        status: 200,
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="PO-0001.pdf"',
          'set-cookie': 'leak=1',
          'x-internal': 'yes',
        },
      }),
    );
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(await res.text()).toBe('%PDF-1.7');
  });

  it('says "not available yet" for a PDF still being prepared, and 502 for a failure', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: {} }, 409));
    expect((await call(ID)).status).toBe(409);
    fetchMock.mockResolvedValueOnce(json({}, 500));
    expect((await call(ID)).status).toBe(502);
  });
});
