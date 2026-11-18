import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import { SessionUnavailableError } from '@/lib/session-unavailable';
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
  orgKind: 'customer',
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
  GET(new Request(`https://app.test/quotations/${id}/document`), {
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

describe('GET /quotations/:id/document', () => {
  it('returns a retryable 503 before fetching a protected document during a session outage', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await call(ID);
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await res.text()).toContain('Retry');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses without a session (401, plain text) and calls nothing', async () => {
    getSession.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a non-id, a 404 and a 403 with the same "Quotation not found"', async () => {
    const bad = await call('not-an-id');
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_found' } }, 404));
    const missing = await call(ID);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'forbidden' } }, 403));
    const foreign = await call(ID);
    for (const res of [bad, missing, foreign]) {
      expect(res.status).toBe(404);
      expect(await res.text()).toBe('Quotation not found.');
    }
  });

  it('says the PDF is not ready when the API answers 409', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'conflict' } }, 409));
    const res = await call(ID);
    expect(res.status).toBe(409);
    expect(await res.text()).toMatch(/not available to download yet/);
  });

  it('streams the file with only the safe headers, never the signed link', async () => {
    fetchMock.mockResolvedValueOnce(json(LINK)).mockResolvedValueOnce(
      new Response('%PDF-1.7', {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="QT-2082-0042-rev2.pdf"',
          'content-security-policy': "sandbox; default-src 'none'",
          'set-cookie': 'leak=1',
          'x-internal-trace': 'abc',
        },
      }),
    );
    const res = await call(ID);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('QT-2082-0042-rev2.pdf');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal-trace')).toBeNull();
    expect(res.headers.get('location')).toBeNull();
    const urls = fetchMock.mock.calls.map(([u]) => (u instanceof URL ? u.href : (u as string)));
    expect(urls).toEqual([
      `http://api:3001/v1/portal/quotations/${ID}/document`,
      'http://api:3001/v1/files/tok.abc-123',
    ]);
  });

  it('answers 502 when the API is down or hands back a strange link', async () => {
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    expect((await call(ID)).status).toBe(502);
    fetchMock.mockResolvedValueOnce(json({ ...LINK, url: 'https://evil.test/x' }));
    expect((await call(ID)).status).toBe(502);
  });
});
