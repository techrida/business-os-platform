import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ID, json, session, stubPortalEnv } from '@/lib/billing-test-support';
import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { GET } = await import('./route');

const fetchMock = vi.fn<typeof fetch>();
const call = (id = ID) =>
  GET(new Request('https://app.test/x'), { params: Promise.resolve({ id }) });

beforeEach(() => {
  stubPortalEnv();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(session);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe('invoice PDF route', () => {
  it('answers a vendor session with the plain 404 and calls nothing', async () => {
    getSession.mockResolvedValue({ ...session, orgKind: 'vendor' });
    const res = await call();
    expect(res.status).toBe(404);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await res.text()).toBe('Invoice not found.');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns a retryable session outage before accessing the API', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('streams the PDF with only the safe headers', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ url: '/v1/files/tok-1', expiresAt: '2026-11-09T10:00:00Z' }))
      .mockResolvedValueOnce(
        new Response('%PDF-1.4', {
          headers: {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="inv.pdf"',
            'x-internal': 'secret',
          },
        }),
      );
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.4');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('x-internal')).toBeNull();
    expect(res.headers.get('cache-control')).toBe('private, no-store');
  });

  it('answers a junk id, a 404 and a 403 with the same plain 404, and a draft is no different', async () => {
    const junk = await call('../admin');
    expect(fetchMock).not.toHaveBeenCalled();
    const bodies = [await junk.text()];
    expect(junk.status).toBe(404);
    for (const status of [404, 403]) {
      fetchMock.mockResolvedValueOnce(
        json({ error: { code: 'x', message: 'draft exists' } }, status),
      );
      const res = await call();
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    expect(new Set(bodies)).toEqual(new Set(['Invoice not found.']));
  });

  it('asks a signed-out visitor to sign in, and reads a PDF still rendering as 409', async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    getSession.mockResolvedValue(session);
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_ready' } }, 409));
    expect((await call()).status).toBe(409);
  });
});
