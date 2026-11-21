import { beforeEach, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const api = vi.hoisted(() => ({ getImport: vi.fn() }));
vi.mock('@/lib/api-imports', () => api);

const { GET } = await import('./route');
const ID = '11111111-1111-4111-8111-111111111111';
const staff: Session = {
  id: 'A'.repeat(43),
  sub: 'u1',
  orgId: 'o1',
  orgKind: 'staff',
  roles: ['sales'],
  accessToken: 't',
  accessExp: 2_000_000_000,
  createdAt: 1,
  lastSeenAt: 1,
};
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });
const req = new Request(`https://app.test/imports/result/${ID}/errors`);

beforeEach(() => {
  vi.clearAllMocks();
  getSession.mockResolvedValue(staff);
  api.getImport.mockResolvedValue({
    id: ID,
    kind: 'vendor',
    rows: [
      {
        line: 3,
        name: '@evil',
        pan: null,
        status: 'error',
        issues: [{ column: 'pan', message: 'bad' }],
      },
    ],
  });
});

it('downloads the stored error report as private CSV with formula text neutralised', async () => {
  const res = await GET(req, ctx());
  expect(res.status).toBe(200);
  expect(res.headers.get('cache-control')).toBe('no-store');
  expect(res.headers.get('content-disposition')).toBe(
    'attachment; filename="vendor-import-errors-11111111.csv"',
  );
  const text = (await res.text()).replace('﻿', '');
  expect(text).toBe(
    '"Line","Name","PAN","Result","Problems"\r\n"3","\'@evil","","Needs fixing","pan: bad"\r\n',
  );
});

it('is 401 without a session, 404 for an unknown or malformed id, and keeps the API refusal status', async () => {
  getSession.mockResolvedValue(null);
  expect((await GET(req, ctx())).status).toBe(401);
  getSession.mockResolvedValue(staff);
  expect((await GET(req, ctx('nope'))).status).toBe(404);
  api.getImport.mockRejectedValue(new ApiError(404, 'x'));
  expect((await GET(req, ctx())).status).toBe(404);
  api.getImport.mockRejectedValue(new ApiError(403, 'x'));
  expect((await GET(req, ctx())).status).toBe(403);
});
