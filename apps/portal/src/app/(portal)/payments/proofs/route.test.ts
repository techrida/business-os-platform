import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { callOf, ID, IDEM, json, session, stubPortalEnv } from '@/lib/billing-test-support';
import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));

const { POST } = await import('./route');

const fetchMock = vi.fn<typeof fetch>();
const PATH = `/v1/portal/payment-proofs/${ID}/versions/${IDEM}/content`;

function upload(
  over: { origin?: string | null; type?: string; name?: string; body?: string } = {},
) {
  const body = over.body ?? 'bytes';
  const headers: Record<string, string> = {
    'content-type': over.type ?? 'application/pdf',
    'content-length': String(body.length),
    'x-file-name': encodeURIComponent(over.name ?? 'bank slip.pdf'),
  };
  if (over.origin !== null) headers.origin = over.origin ?? 'https://app.test';
  return POST(
    new Request('https://app.test/payments/proofs', {
      method: 'POST',
      headers,
      body,
      // Node's Request needs this to carry a stream body.
      duplex: 'half',
    } as RequestInit),
  );
}

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

describe('proof upload route', () => {
  it('returns a retryable session outage before accessing the API', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.json()).toEqual({ error: SESSION_UNAVAILABLE_MESSAGE });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stores the file through the API and returns only the document id and name', async () => {
    fetchMock
      .mockResolvedValueOnce(json({ documentId: ID, versionId: IDEM, uploadPath: PATH }, 201))
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const res = await upload();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documentId: ID, filename: 'bank slip.pdf' });
    expect(JSON.parse(callOf(fetchMock, 0).init.body as string)).toEqual({
      filename: 'bank slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 5,
    });
  });

  it('refuses another origin, a signed-out caller and a wrong type before calling the API', async () => {
    expect((await upload({ origin: 'https://evil.test' })).status).toBe(403);
    expect((await upload({ origin: null })).status).toBe(403);
    getSession.mockResolvedValue(null);
    expect((await upload()).status).toBe(401);
    getSession.mockResolvedValue(session);
    const exe = await upload({ type: 'application/x-msdownload' });
    expect(exe.status).toBe(422);
    expect(((await exe.json()) as { error: string }).error).toMatch(/not a PDF/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an API refusal into plain words for the customer', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ error: { code: 'x', message: 'quarantine node 7' } }, 415),
    );
    const res = await upload();
    expect(res.status).toBe(415);
    expect(JSON.stringify(await res.json())).not.toContain('quarantine');
    fetchMock.mockResolvedValueOnce(new Response('down', { status: 503 }));
    expect((await upload()).status).toBe(502);
  });
});
