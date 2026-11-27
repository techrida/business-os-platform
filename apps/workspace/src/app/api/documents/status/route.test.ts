import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

import { GET } from './route';

vi.mock('server-only', () => ({}));

const mocks = vi.hoisted(() => ({ routeSession: vi.fn(), apiFetch: vi.fn() }));
vi.mock('@/lib/bff', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/bff')>()),
  routeSession: mocks.routeSession,
}));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  apiFetch: mocks.apiFetch,
}));

const QUOTATION = '11111111-1111-4111-8111-111111111111';
const VERSION = '22222222-2222-4222-8222-222222222222';
const session = { accessToken: 'token' } as Session;

function call(query = `quotationId=${QUOTATION}&versionId=${VERSION}`): Promise<Response> {
  return GET(new Request(`https://app.test/api/documents/status?${query}`));
}

beforeEach(() => {
  mocks.routeSession.mockReset().mockResolvedValue(session);
  mocks.apiFetch.mockReset();
});

describe('GET /api/documents/status', () => {
  it('refuses ids that are not ids before any API call', async () => {
    const res = await call('quotationId=x&versionId=y');
    expect(res.status).toBe(400);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('passes a signed-out answer through', async () => {
    mocks.routeSession.mockResolvedValue(new Response(null, { status: 401 }));
    expect((await call()).status).toBe(401);
    expect(mocks.apiFetch).not.toHaveBeenCalled();
  });

  it('answers a failed API read as an error, not as ready', async () => {
    mocks.apiFetch.mockResolvedValue(new Response('{}', { status: 404 }));
    const res = await call();
    expect(res.status).toBe(404);
  });
});
