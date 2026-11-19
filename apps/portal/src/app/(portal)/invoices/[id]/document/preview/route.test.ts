import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ID, json, session as customerSession, stubPortalEnv } from '@/lib/billing-test-support';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { GET } = await import('./route');

const session: Session = { ...customerSession, orgKind: 'customer' };
const fetchMock = vi.fn<typeof fetch>();
const call = (id = ID) =>
  GET(new Request('https://app.test/x'), { params: Promise.resolve({ id }) });
const LINK = { url: '/v1/files/tok-1', expiresAt: '2026-11-09T10:00:00Z' };
const urls = () => fetchMock.mock.calls.map(([u]) => (u instanceof URL ? u.href : (u as string)));

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

describe('invoice preview route', () => {
  it('serves the PDF inline with the preview headers and one signed-link request', async () => {
    fetchMock.mockResolvedValueOnce(json(LINK)).mockResolvedValueOnce(
      new Response('%PDF-1.7', {
        headers: {
          'content-type': 'application/pdf',
          'content-disposition': 'attachment; filename="doc.pdf"',
          'content-security-policy': "sandbox; default-src 'none'",
          'set-cookie': 'leak=1',
          'x-internal': 'yes',
        },
      }),
    );
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline; filename="doc.pdf"');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();
    expect(urls()).toHaveLength(2);
    expect(urls()[0]).toContain('/v1/portal/invoices/');
    expect(urls()[1]).toBe('http://api:3001/v1/files/tok-1');
  });

  it('answers 415 for anything that is not a PDF', async () => {
    fetchMock
      .mockResolvedValueOnce(json(LINK))
      .mockResolvedValueOnce(
        new Response('<script>alert(1)</script>', { headers: { 'content-type': 'text/html' } }),
      );
    const res = await call();
    expect(res.status).toBe(415);
    expect(res.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(res.headers.get('content-disposition')).toBeNull();
    expect(urls()).toHaveLength(2);
  });

  it('answers a junk id, a 404 and a 403 from the API, and the other org kind, with the same 404', async () => {
    const bodies = [await (await call('../admin')).text()];
    expect(fetchMock).not.toHaveBeenCalled();
    for (const status of [404, 403]) {
      fetchMock.mockResolvedValueOnce(json({ error: { code: 'x' } }, status));
      const res = await call();
      expect(res.status).toBe(404);
      bodies.push(await res.text());
    }
    getSession.mockResolvedValue({ ...session, orgKind: 'vendor' });
    const other = await call();
    expect(other.status).toBe(404);
    bodies.push(await other.text());
    expect(new Set(bodies)).toEqual(new Set(['Invoice not found.']));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('reads a PDF still rendering (409) as not ready, and asks a signed-out visitor to sign in', async () => {
    fetchMock.mockResolvedValueOnce(json({ error: { code: 'not_ready' } }, 409));
    expect((await call()).status).toBe(409);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
