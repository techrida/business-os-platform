import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
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

const QUOTATION = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const session = { accessToken: 'eyJ.secret-access-token.sig' } as Session;
const LINK = { url: '/v1/files/abc.def', expiresAt: '2026-11-08T05:46:00.000Z' };

function call(id: string = QUOTATION, vid: string = VERSION): Promise<Response> {
  return GET(new Request('https://app.test/x'), { params: Promise.resolve({ id, vid }) });
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
        'content-disposition': 'attachment; filename="QT-2082-0042.pdf"',
        'content-security-policy': "sandbox; default-src 'none'",
      },
    }),
  );
});

describe('GET /quotations/:id/versions/:vid/document/preview', () => {
  it('streams the PDF inline through one newly issued link, without the sandbox policy', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();

    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    const [, path, init] = mocks.apiFetch.mock.calls[0] as [Session, string, RequestInit];
    expect(path).toBe(`/v1/quotations/${QUOTATION}/versions/${VERSION}/document`);
    expect(init.method).toBe('GET');
    expect(mocks.openSignedFile).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).toHaveBeenCalledWith(session, LINK);
  });

  it('does not display a non-PDF stream', async () => {
    mocks.openSignedFile.mockResolvedValue(
      new Response('<script>unexpected()</script>', { headers: { 'content-type': 'text/html' } }),
    );
    const res = await call();
    expect(res.status).toBe(415);
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8');
    expect(await res.text()).toBe('This file cannot be previewed.');
  });

  it.each([401, 403])(
    'answers a %i session refusal in plain text before the API',
    async (status) => {
      mocks.routeSession.mockResolvedValue(json(status, {}));
      const res = await call();
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(mocks.apiFetch).not.toHaveBeenCalled();
    },
  );

  it('rejects a bad id with 400 before the session or the API', async () => {
    expect((await call('../admin')).status).toBe(400);
    expect((await call(QUOTATION, 'nope')).status).toBe(400);
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it.each([409, 404])('turns a %i from the API into a plain "not available"', async (status) => {
    mocks.apiFetch.mockResolvedValue(json(status, { error: { code: 'not_clean' } }));
    const res = await call();
    expect(res.status).toBe(status);
    expect(await res.text()).toMatch(/not available/i);
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it.each([403, 404])("passes another tenant's %i through and opens nothing", async (status) => {
    mocks.apiFetch.mockResolvedValue(json(status, { error: { code: 'not_found' } }));
    const res = await call();
    expect(res.status).toBe(status);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(mocks.apiFetch).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('says "not available" when the signed link itself turns out to be gone', async () => {
    mocks.openSignedFile.mockRejectedValue(new ApiError(404, 'gone'));
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not available/i);
  });
});
