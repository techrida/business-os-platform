import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

import { DELETE } from './route';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({
  routeSession: vi.fn(),
  isSameOrigin: vi.fn(),
  removeEvidenceDocument: vi.fn(),
}));

// The real bff reads the environment and cookies; the route's own order of checks is what is tested.
vi.mock('@/lib/bff', () => ({
  routeSession: mocks.routeSession,
  isSameOrigin: mocks.isSameOrigin,
  forbiddenOrigin: () => Response.json({ error: { message: 'origin' } }, { status: 403 }),
  jsonResponse: (body: unknown, status = 200) => Response.json(body, { status }),
  errorResponse: (err: unknown) =>
    Response.json(
      { error: { message: 'remove failed' } },
      { status: err instanceof ApiError && err.status < 500 ? err.status : 502 },
    ),
}));
vi.mock('@/lib/api-kernel', () => ({ removeEvidenceDocument: mocks.removeEvidenceDocument }));

const ORDER = '11111111-1111-4111-8111-111111111111';
const DOC = '33333333-3333-4333-8333-333333333333';
const session = { accessToken: 'secret' } as Session;

function remove(kind = 'sales-order', ownerId = ORDER, documentId = DOC): Promise<Response> {
  return DELETE(
    new Request(`https://app.test/api/evidence/${kind}/${ownerId}/${documentId}`, {
      method: 'DELETE',
    }),
    { params: Promise.resolve({ kind, ownerId, documentId }) },
  );
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.isSameOrigin.mockReset().mockReturnValue(true);
  mocks.removeEvidenceDocument.mockReset().mockResolvedValue(undefined);
});

describe('DELETE /api/evidence/:kind/:ownerId/:documentId', () => {
  it.each(['sales-order', 'vendor-bill', 'rfq', 'quotation-version'])(
    'removes the file through the %s record route and answers 204, uncached',
    async (kind) => {
      const res = await remove(kind);
      expect(res.status).toBe(204);
      expect(res.headers.get('cache-control')).toBe('no-store');
      expect(mocks.removeEvidenceDocument).toHaveBeenCalledWith(session, kind, ORDER, DOC);
    },
  );

  it('refuses another origin before it looks at the session', async () => {
    mocks.isSameOrigin.mockReturnValue(false);
    expect((await remove()).status).toBe(403);
    expect(mocks.routeSession).not.toHaveBeenCalled();
    expect(mocks.removeEvidenceDocument).not.toHaveBeenCalled();
  });

  it('returns the session response as is when nobody is signed in', async () => {
    mocks.routeSession.mockResolvedValue(
      Response.json({ error: { message: 'in' } }, { status: 401 }),
    );
    expect((await remove()).status).toBe(401);
    expect(mocks.removeEvidenceDocument).not.toHaveBeenCalled();
  });

  it.each([
    ['an unknown kind', 'memo', ORDER, DOC],
    ['a record id that is not a UUID', 'sales-order', 'x', DOC],
    ['a document id that is not a UUID', 'sales-order', ORDER, '../x'],
  ])('answers 400 to %s without calling the API', async (_label, kind, ownerId, documentId) => {
    expect((await remove(kind, ownerId, documentId)).status).toBe(400);
    expect(mocks.removeEvidenceDocument).not.toHaveBeenCalled();
  });

  it.each([403, 404, 409])('passes the API refusal %i through', async (status) => {
    mocks.removeEvidenceDocument.mockRejectedValue(new ApiError(status, 'refused'));
    expect((await remove()).status).toBe(status);
  });
});
