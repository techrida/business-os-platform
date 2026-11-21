import { DEFAULT_ROLE_PERMISSIONS } from '@bos/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { SESSION_UNAVAILABLE_MESSAGE, SessionUnavailableError } from '@/lib/session-unavailable';

import { CUSTOMER_ID } from '../_lib/fixtures';

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

const DOC_ID = '12345678-1234-4234-8234-123456789012';
const VER_ID = '87654321-4321-4321-8321-210987654321';
const PATH = `/v1/payment-proofs/${DOC_ID}/versions/${VER_ID}/content`;
const staff = { accessToken: 'tok', orgKind: 'staff', roles: ['accountant'] };

const fetchMock = vi.fn<typeof fetch>();
/**
 * What GET /v1/me answers: a status, or the live grant list. `undefined` gives the caller's role defaults, which
 * is what the API reports for a role nobody edited in Settings > Access.
 */
let meAnswer: number | string[] | undefined;
const meBody = (roles: string[], permissions: string[]) => ({
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  partyId: null,
  roles,
  correlationId: 'req-12345678',
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});
const roleDefaults = (roles: string[]) =>
  roles.flatMap((r) =>
    Object.keys(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS] ?? {}),
  );
/** Answers /v1/me from `meAnswer`; every other call goes to `fetchMock`, so its call list is the upload's alone. */
const meCalls = vi.fn<(roles: string[]) => void>();
function routedFetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const url = new URL(input instanceof Request ? input.url : input);
  if (url.pathname !== '/v1/me') return fetchMock(input, init);
  const roles = currentRoles();
  meCalls(roles);
  if (typeof meAnswer === 'number') return Promise.resolve(json({}, meAnswer));
  return Promise.resolve(json(meBody(roles, meAnswer ?? roleDefaults(roles))));
}
let currentRoles = () => staff.roles;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const started = () => json({ documentId: DOC_ID, versionId: VER_ID, uploadPath: PATH }, 201);
const callOf = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [URL, RequestInit];
  return { url, init };
};

function upload(
  over: {
    origin?: string | null;
    type?: string;
    name?: string;
    rawName?: string;
    body?: string;
    customer?: string | null;
  } = {},
) {
  const body = over.body ?? 'bytes';
  const headers: Record<string, string> = {
    'content-type': over.type ?? 'application/pdf',
    'content-length': String(body.length),
    'x-file-name': over.rawName ?? encodeURIComponent(over.name ?? 'bank slip.pdf'),
  };
  if (over.customer !== null) headers['x-customer-id'] = over.customer ?? CUSTOMER_ID;
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

const messageOf = async (res: Response) =>
  ((await res.json()) as { error: { message: string } }).error.message;

beforeEach(() => {
  fetchMock.mockReset();
  meCalls.mockReset();
  meAnswer = undefined;
  vi.stubGlobal('fetch', routedFetch);
  getSession.mockReset();
  getSession.mockResolvedValue(staff);
  currentRoles = () => staff.roles;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('proof upload route', () => {
  it('returns a retryable session outage the form can show, before accessing the API', async () => {
    getSession.mockRejectedValue(new SessionUnavailableError());
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    // payment-form.tsx shows `error.message` beside the file name.
    expect(await messageOf(res)).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('announces the file for the customer, streams the bytes, and returns the document id', async () => {
    fetchMock
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const res = await upload();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ documentId: DOC_ID, filename: 'bank slip.pdf' });

    const first = callOf(0);
    expect(first.url.pathname).toBe('/v1/payment-proofs');
    expect(JSON.parse(first.init.body as string)).toEqual({
      customerId: CUSTOMER_ID,
      filename: 'bank slip.pdf',
      declaredMime: 'application/pdf',
      sizeBytes: 5,
    });
    const second = callOf(1);
    expect(second.url.pathname).toBe(PATH);
    expect(second.init.method).toBe('PUT');
    const headers = second.init.headers as Headers;
    expect(headers.get('content-type')).toBe('application/pdf');
    expect(headers.get('authorization')).toBe('Bearer tok');
    // A stream is forwarded, never a buffered copy.
    expect(second.init.body).toBeInstanceOf(ReadableStream);
  });

  it('refuses another origin, a signed-out caller and a person without payment.record before calling the API', async () => {
    expect((await upload({ origin: 'https://evil.test' })).status).toBe(403);
    expect((await upload({ origin: null })).status).toBe(403);
    getSession.mockResolvedValue(null);
    expect((await upload()).status).toBe(401);
    getSession.mockResolvedValue({ ...staff, roles: ['management'] });
    currentRoles = () => ['management'];
    const denied = await upload();
    expect(denied.status).toBe(403);
    expect(await messageOf(denied)).toMatch(/do not include recording payments/);
    getSession.mockResolvedValue({ ...staff, orgKind: 'customer' });
    expect((await upload()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lets a role granted payment.record in Settings > Access upload, by the live grants', async () => {
    getSession.mockResolvedValue({ ...staff, roles: ['management'] });
    currentRoles = () => ['management'];
    meAnswer = ['payment.read', 'payment.record'];
    fetchMock
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    const res = await upload();
    expect(res.status).toBe(200);
    expect(meCalls).toHaveBeenCalledTimes(1);
    expect(callOf(0).url.pathname).toBe('/v1/payment-proofs');
  });

  it('refuses a role whose payment.record was taken away, even though its defaults include it', async () => {
    meAnswer = ['payment.read'];
    const denied = await upload();
    expect(denied.status).toBe(403);
    expect(await messageOf(denied)).toMatch(/do not include recording payments/);
    // An empty live list means the user may not act; it is not read as a failed lookup.
    meAnswer = [];
    expect((await upload()).status).toBe(403);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('falls back to the role defaults only when /v1/me fails', async () => {
    meAnswer = 500;
    fetchMock
      .mockResolvedValueOnce(started())
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect((await upload()).status).toBe(200);
    getSession.mockResolvedValue({ ...staff, roles: ['management'] });
    currentRoles = () => ['management'];
    expect((await upload()).status).toBe(403);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('needs a real customer id, a PDF or picture, a size and a name before calling the API', async () => {
    expect((await upload({ customer: null })).status).toBe(400);
    expect((await upload({ customer: 'not-a-uuid' })).status).toBe(400);
    const exe = await upload({ type: 'application/x-msdownload' });
    expect(exe.status).toBe(422);
    expect(await messageOf(exe)).toMatch(/not a PDF or a picture/);
    expect((await upload({ body: '' })).status).toBe(422);
    expect((await upload({ rawName: 'a%2Fb.pdf' })).status).toBe(422);
    expect((await upload({ rawName: '%E0%A4%A' })).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('turns an API refusal into plain words and never repeats the API’s own text', async () => {
    const cases: [number, number, RegExp][] = [
      [404, 404, /find that customer/],
      [413, 413, /too large/],
      [415, 415, /not accepted/],
      [422, 422, /not accepted/],
      [403, 403, /do not include recording payments/],
      [401, 401, /Sign in again/],
      [500, 502, /try again/],
    ];
    for (const [api, ours, words] of cases) {
      fetchMock.mockReset();
      fetchMock.mockResolvedValueOnce(
        json({ error: { code: 'x', message: 'quarantine node 7' } }, api),
      );
      const res = await upload();
      expect(res.status).toBe(ours);
      const message = await messageOf(res);
      expect(message).toMatch(words);
      expect(message).not.toMatch(/quarantine/);
    }
  });

  it('passes a db_busy 503 through with its wait instead of a 502', async () => {
    fetchMock.mockResolvedValueOnce(
      json(
        {
          error: {
            code: 'db_busy',
            message: 'Busy, please try again',
            correlationId: 'c-1',
            details: { retryAfterSeconds: 2 },
          },
        },
        503,
      ),
    );
    const res = await upload();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('2');
    expect(await messageOf(res)).toBe('Busy, please try again.');
  });

  it('words a refusal of the byte upload the same way', async () => {
    fetchMock.mockResolvedValueOnce(started()).mockResolvedValueOnce(json({}, 413));
    expect((await upload()).status).toBe(413);
  });

  it('does not send the bearer token to an upload path in an unexpected form', async () => {
    fetchMock.mockResolvedValueOnce(
      json({ documentId: DOC_ID, versionId: VER_ID, uploadPath: '/v1/documents/x/content' }, 201),
    );
    const res = await upload();
    expect(res.status).toBe(502);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
