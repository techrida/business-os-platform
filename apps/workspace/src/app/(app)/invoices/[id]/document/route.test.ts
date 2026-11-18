import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import { SESSION_UNAVAILABLE_MESSAGE, sessionUnavailableResponse } from '@/lib/session-unavailable';
import type { Session } from '@/lib/session';

import { GET } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  apiFetch: vi.fn(),
  openSignedFile: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ routeSession: mocks.routeSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  openSignedFile: mocks.openSignedFile,
}));

const INVOICE = '11111111-1111-4111-8111-111111111111';
const session = { accessToken: 'eyJ.secret-access-token.sig' } as Session;
const LINK = { url: '/v1/files/abc.def', expiresAt: '2026-11-08T05:46:00.000Z' };

function call(id: string = INVOICE): Promise<Response> {
  return GET(new Request('https://app.test/x'), { params: Promise.resolve({ id }) });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.apiFetch.mockReset().mockResolvedValue(json(200, LINK));
  mocks.openSignedFile.mockReset().mockResolvedValue(
    new Response('%PDF-1.7', {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="INV-2083-84-00001.pdf"',
        'content-security-policy': "sandbox; default-src 'none'",
      },
    }),
  );
});

describe('GET /invoices/:id/document', () => {
  it('returns a retryable session outage before accessing the API', async () => {
    mocks.routeSession.mockResolvedValue(sessionUnavailableResponse());
    const res = await call();
    expect(res.status).toBe(503);
    expect(res.headers.get('retry-after')).toBe('1');
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(await res.text()).toBe(SESSION_UNAVAILABLE_MESSAGE);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('asks the API for one link, then streams the file with its safe headers', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [Session, string, RequestInit];
    expect(path).toBe(`/v1/invoices/${INVOICE}/document`);
    expect(init.method).toBe('GET');
    expect(mocks.openSignedFile).toHaveBeenCalledWith(session, LINK);
  });

  it('never reaches the API with an id that is not a UUID', async () => {
    const res = await call('../admin');
    expect(res.status).toBe(400);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
    expect(mocks.routeSession).not.toHaveBeenCalled();
  });

  it('answers a signed-out visitor in plain text, without calling the API', async () => {
    mocks.routeSession.mockResolvedValue(json(401, { error: { message: 'Sign in' } }));
    const res = await call();
    expect(res.status).toBe(401);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it.each([409, 404])('turns a %i from the API into a plain "not available"', async (status) => {
    mocks.apiFetch.mockResolvedValue(json(status, { error: { code: 'not_clean' } }));
    const res = await call();
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(await res.text()).toMatch(/not available/i);
    // One call and no retry: every call issues a single-use link, so nothing may probe.
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('says "not available" when the signed link itself turns out to be gone', async () => {
    mocks.openSignedFile.mockRejectedValue(new ApiError(404, 'gone'));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not available/i);
  });

  it('turns a link body that breaks the contract into a 502 and opens nothing', async () => {
    mocks.apiFetch.mockResolvedValue(json(200, { url: '' }));
    const res = await call();
    expect(res.status).toBe(502);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('answers an upstream failure with 502 and never prints the access token', async () => {
    mocks.apiFetch.mockResolvedValue(json(500, { error: { code: 'internal' } }));
    const res = await call();
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain(session.accessToken);
  });
});
