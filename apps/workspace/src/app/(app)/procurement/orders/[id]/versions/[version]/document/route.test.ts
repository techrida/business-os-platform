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

describe('GET /procurement/orders/:id/versions/:version/document', () => {
  it('asks the API for one link for that version, then streams the file with its safe headers', async () => {
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('%PDF-1.7');
    expect(res.headers.get('content-disposition')).toContain('attachment');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('cache-control')).toBe('private, no-store');
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledTimes(1);
    expect(mocks.issuePoDocumentLink).toHaveBeenCalledWith(session, PO, 2);
    expect(mocks.openSignedFile).toHaveBeenCalledWith(session, LINK);
  });

  it('never reaches the API with an id that is not a UUID or a version that is not a positive whole number', async () => {
    for (const [id, version] of [
      ['../admin', '1'],
      [PO, '0'],
      [PO, '-1'],
      [PO, '1.5'],
      [PO, 'abc'],
      [PO, '1; drop'],
    ] as const) {
      const res = await call(id, version);
      expect(res.status).toBe(400);
      expect(res.headers.get('content-type')).toContain('text/plain');
    }
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.issuePoDocumentLink).not.toHaveBeenCalled();
  });

  it('answers the session refusal as plain text', async () => {
    mocks.routeSession.mockResolvedValue(new Response(null, { status: 401 }));
    const res = await call();
    expect(res.status).toBe(401);
    expect(await res.text()).toMatch(/sign in/i);
    expect(mocks.issuePoDocumentLink).not.toHaveBeenCalled();
  });

  it('turns a 404 (not rendered or not clean yet) into a plain "not available"', async () => {
    mocks.issuePoDocumentLink.mockRejectedValue(
      new ApiError(404, 'x', { error: { code: 'not_found' } }),
    );
    const res = await call();
    expect(res.status).toBe(404);
    expect(await res.text()).toMatch(/not available/i);
    expect(mocks.openSignedFile).not.toHaveBeenCalled();
  });

  it('shows a 403 as plain words and an upstream fault as a 502', async () => {
    mocks.issuePoDocumentLink.mockRejectedValue(
      new ApiError(403, 'x', { error: { code: 'forbidden', reason: 'no_permission' } }),
    );
    expect((await call()).status).toBe(403);
    mocks.issuePoDocumentLink.mockRejectedValue(new ApiError(500, 'x'));
    expect((await call()).status).toBe(502);
  });
});
