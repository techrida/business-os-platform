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

const PO = '11111111-1111-4111-8111-111111111111';
const staff = { accessToken: 'tok', orgKind: 'staff', roles: ['procurement'] };

const fetchMock = vi.fn<typeof fetch>();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function call(
  over: { origin?: string | null; id?: string; version?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (over.origin !== null) headers.origin = over.origin ?? 'https://app.test';
  return POST(new Request('https://app.test/x', { method: 'POST', headers }), {
    params: Promise.resolve({ id: over.id ?? PO, version: over.version ?? '2' }),
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

// The purchase order PDF Retry (round 4, R4c2): the shared handler (pdf-retry-route.ts) on the version's API path.
describe('POST /procurement/orders/:id/versions/:version/document/retry', () => {
  it('posts the retry to the API as the session user and answers 202 queued', async () => {
    fetchMock.mockResolvedValue(json({ state: 'queued' }, 202));
    const res = await call();
    expect(res.status).toBe(202);
    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.pathname).toBe(`/v1/procurement/purchase-orders/${PO}/versions/2/document/retry`);
    expect(init.method).toBe('POST');
  });

  it('refuses another origin, a bad id and a bad version before the API', async () => {
    expect((await call({ origin: 'https://evil.test' })).status).toBe(403);
    expect((await call({ id: 'nope' })).status).toBe(400);
    for (const version of ['0', '-1', '1.5', 'x', '01']) {
      expect((await call({ version })).status, version).toBe(400);
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('words an API 409 in our own text', async () => {
    fetchMock.mockResolvedValue(
      json({ error: { code: 'purchase_order_pdf_retry_not_needed', message: 'x' } }, 409),
    );
    const res = await call();
    expect(res.status).toBe(409);
    expect(await messageOf(res)).toBe('This PDF does not need another try.');
  });
});
