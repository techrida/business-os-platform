import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

import { GET } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  issuePoDocumentLink: vi.fn(),
  openSignedFile: vi.fn(),
}));

vi.mock('@/lib/bff', () => ({ routeSession: mocks.routeSession }));
vi.mock('@/lib/api-purchase-orders', () => ({ issuePoDocumentLink: mocks.issuePoDocumentLink }));
vi.mock('@/lib/api-kernel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-kernel')>()),
  openSignedFile: mocks.openSignedFile,
}));

const PO = '11111111-1111-4111-8111-111111111111';
const session = { accessToken: 'eyJ.secret-access-token.sig' } as Session;
const LINK = { url: '/v1/files/abc.def', expiresAt: '2026-11-08T05:46:00.000Z' };

function call(id: string = PO, version = '2'): Promise<Response> {
  return GET(new Request('https://app.test/x'), { params: Promise.resolve({ id, version }) });
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.issuePoDocumentLink.mockReset().mockResolvedValue(LINK);
  mocks.openSignedFile.mockReset().mockResolvedValue(
    new Response('%PDF-1.7', {
      headers: {
        'content-type': 'application/pdf',
        'content-disposition': 'attachment; filename="PO-2082-0001-v2.pdf"',
        'content-security-policy': "sandbox; default-src 'none'",
      },
    }),
  );
});

describe('GET /procurement/orders/:id/versions/:version/document/preview', () => {
  it('streams that version inline through one newly issued link, without the sandbox policy', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-type')).toBe('application/pdf');
    expect(res.headers.get('content-disposition')).toBe('inline');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(res.headers.get('content-security-policy')).toBeNull();
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledTimes(1);
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledWith(session, PO, 2);
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
      mocks.routeSession.mockResolvedValue(new Response(null, { status }));
      const res = await call();
      expect(res.status).toBe(status);
      expect(res.headers.get('content-type')).toContain('text/plain');
      expect(mocks.issuePoDocumentLink).not.toHaveBeenCalled();
    },
  );

  it('rejects a bad id or version with 400 before the session or the API', async () => {
    for (const [id, version] of [
      ['../admin', '1'],
      [PO, '0'],
      [PO, '1.5'],
      [PO, 'abc'],
    ] as const) {
      expect((await call(id, version)).status).toBe(400);
    }
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.issuePoDocumentLink).not.toHaveBeenCalled();
  });

  it.each([
    [404, /not available/i],
    [409, /still being prepared/i],
  ])('turns a %i (not rendered or not clean) into a plain message', async (status, message) => {
    mocks.issuePoDocumentLink.mockRejectedValue(new ApiError(status, 'x'));
    const res = await call();
    expect(res.status).toBe(status);
    expect(await res.text()).toMatch(message);
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it("passes another tenant's 403 through and opens nothing", async () => {
    mocks.issuePoDocumentLink.mockRejectedValue(
      new ApiError(403, 'x', { error: { code: 'forbidden', reason: 'no_permission' } }),
    );
    const res = await call();
    expect(res.status).toBe(403);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledTimes(1);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });
});
