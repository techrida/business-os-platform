import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<unknown>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
vi.mock('@/lib/env', () => ({
  getEnv: () => ({
    WORKSPACE_PUBLIC_URL: 'https://app.test',
    API_INTERNAL_URL: 'http://api.test',
  }),
}));

const { POST } = await import('./route');

const QUOTATION = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const staff = { accessToken: 'tok', orgKind: 'staff', roles: ['sales'] };

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function call(over: { origin?: string | null; id?: string; vid?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (over.origin !== null) headers.origin = over.origin ?? 'https://app.test';
  return POST(new Request('https://app.test/x', { method: 'POST', headers }), {
    params: Promise.resolve({ id: over.id ?? QUOTATION, vid: over.vid ?? VERSION }),
  });
}

const messageOf = async (res: Response) =>
  ((await res.json()) as { error: { message: string } }).error.message;

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  getSession.mockReset();
  getSession.mockResolvedValue(staff);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('POST /quotations/:id/versions/:vid/document/retry', () => {
  it('posts the retry to the API as the session user and answers 202 queued', async () => {
    fetchMock.mockResolvedValue(json({ state: 'queued' }, 202));
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: 'queued' });
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/v1/quotations/${QUOTATION}/versions/${VERSION}/document/retry`);
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok');
  });

  it('refuses a request from another origin, or with none, before the session or the API', async () => {
    expect((await call({ origin: 'https://evil.test' })).status).toBe(403);
    expect((await call({ origin: null })).status).toBe(403);
    expect(getSession).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('never reaches the API with an id that is not a UUID', async () => {
    const res = await call({ id: '../admin' });
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('answers a signed-out visitor with 401 and a portal user with 403, without calling the API', async () => {
    getSession.mockResolvedValue(null);
    expect((await call()).status).toBe(401);
    getSession.mockResolvedValue({ accessToken: 'tok', orgKind: 'customer', roles: [] });
    expect((await call()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps a session outage retryable', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(await messageOf(res)).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'quotation_pdf_retry_not_needed', 409, 'This PDF does not need another try.'],
    [404, 'not_found', 404, 'This PDF is not available.'],
    [403, 'forbidden', 403, 'You cannot ask for this PDF to be prepared again.'],
    [500, 'internal', 502, 'The retry could not be requested.'],
  ])('words an API %i in our own text', async (apiStatus, code, status, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: 'internal detail' } }, apiStatus));
    const res = await call();
    expect(res.status).toBe(status);
    expect(await messageOf(res)).toBe(message);
  });

  it('answers 502 when the API cannot be reached', async () => {
    fetchMock.mockRejectedValue(new TypeError('offline'));
    const res = await call();
    expect(res.status).toBe(502);
  });
});
