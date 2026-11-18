import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __resetEnvForTests } from '@/lib/env';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));

const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const fetchMock = vi.fn<typeof fetch>();

const { DELETE } = await import('./route');

const DOC_ID = '11111111-1111-4111-8111-111111111111';
const TOKEN = 'eyJ.secret-token.sig';

const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: TOKEN,
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};

function makeReq(origin?: string): Request {
  return new Request(`https://app.test/api/documents/${DOC_ID}`, {
    method: 'DELETE',
    ...(origin !== undefined ? { headers: { origin } } : {}),
  });
}

const ctx = (documentId = DOC_ID) => ({ params: Promise.resolve({ documentId }) });

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
  getSession.mockResolvedValue(staff);
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('DELETE /api/documents/[documentId]', () => {
  it('refuses wrong-origin and missing-origin deletes with 403 before session or API calls', async () => {
    for (const origin of ['https://evil.test', 'http://app.test', undefined]) {
      const res = await DELETE(makeReq(origin), ctx());
      expect(res.status).toBe(403);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(getSession).not.toHaveBeenCalled();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  });

  it('returns 401 when unauthenticated and 403 for non-staff sessions', async () => {
    getSession.mockResolvedValueOnce(null);
    const unauth = await DELETE(makeReq('https://app.test'), ctx());
    expect(unauth.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();

    getSession.mockResolvedValueOnce({ ...staff, orgKind: 'customer' });
    const nonStaff = await DELETE(makeReq('https://app.test'), ctx());
    expect(nonStaff.status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns 400 for an invalid document id and does not call the API', async () => {
    const res = await DELETE(makeReq('https://app.test'), ctx('../etc/passwd'));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('forwards same-origin staff DELETE to /v1/documents/:id and answers 204 no-store', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    const res = await DELETE(makeReq('https://app.test'), ctx());
    expect(res.status).toBe(204);
    expect(res.headers.get('cache-control')).toBe('no-store');

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const href = url instanceof Request ? url.url : url instanceof URL ? url.href : (url ?? '');
    expect(href).toBe(`http://api:3001/v1/documents/${DOC_ID}`);
    expect(init?.method).toBe('DELETE');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TOKEN}`);
  });

  it('forwards 401, 403, 404, and 409 conflicts with reload guidance and turns 5xx into 502', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    expect((await DELETE(makeReq('https://app.test'), ctx())).status).toBe(401);

    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'forbidden',
            message: 'denied',
            correlationId: 'req-12345678',
            reason: 'no_permission',
          },
        },
        { status: 403 },
      ),
    );
    const r403 = await DELETE(makeReq('https://app.test'), ctx());
    expect(r403.status).toBe(403);
    expect(((await r403.json()) as { error: { message: string } }).error.message).toContain(
      'roles',
    );

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect((await DELETE(makeReq('https://app.test'), ctx())).status).toBe(404);

    fetchMock.mockResolvedValueOnce(
      Response.json(
        {
          error: {
            code: 'conflict',
            message: 'This record no longer accepts attachments',
            correlationId: 'req-12345678',
          },
        },
        { status: 409 },
      ),
    );
    const r409 = await DELETE(makeReq('https://app.test'), ctx());
    expect(r409.status).toBe(409);
    const body409 = (await r409.json()) as { error: { message: string; reload: boolean } };
    expect(body409.error.message).toContain('draft or returned');
    expect(body409.error.reload).toBe(true);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 500 }));
    expect((await DELETE(makeReq('https://app.test'), ctx())).status).toBe(502);
  });
});
