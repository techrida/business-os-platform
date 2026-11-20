import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

const INVOICE = '11111111-1111-4111-8111-111111111111';
const staff = { accessToken: 'tok', orgKind: 'staff', roles: ['finance'] };

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function call(over: { origin?: string | null; id?: string } = {}): Promise<Response> {
  const headers: Record<string, string> = {};
  if (over.origin !== null) headers.origin = over.origin ?? 'https://app.test';
  return POST(new Request('https://app.test/x', { method: 'POST', headers }), {
    params: Promise.resolve({ id: over.id ?? INVOICE }),
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

// The invoice PDF Retry (round 4, R4c2): the shared handler (pdf-retry-route.ts) on the invoice's API path.
describe('POST /invoices/:id/document/retry', () => {
  it('posts the retry to the API as the session user and answers 202 queued', async () => {
    fetchMock.mockResolvedValue(json({ state: 'queued' }, 202));
    const res = await call();
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ state: 'queued' });
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/v1/invoices/${INVOICE}/document/retry`);
    expect(init.method).toBe('POST');
    expect((init.headers as Headers).get('authorization')).toBe('Bearer tok');
  });

  it('refuses another origin and an id that is not a UUID before the API', async () => {
    expect((await call({ origin: 'https://evil.test' })).status).toBe(403);
    expect((await call({ id: '../admin' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [409, 'invoice_pdf_retry_not_needed', 409, 'This PDF does not need another try.'],
    [404, 'not_found', 404, 'This PDF is not available.'],
    [403, 'forbidden', 403, 'You cannot ask for this PDF to be prepared again.'],
  ])('words an API %i in our own text', async (apiStatus, code, status, message) => {
    fetchMock.mockResolvedValue(json({ error: { code, message: 'internal detail' } }, apiStatus));
    const res = await call();
    expect(res.status).toBe(status);
    expect(await messageOf(res)).toBe(message);
  });
});
