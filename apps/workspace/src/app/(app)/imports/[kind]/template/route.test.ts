import { PARTY_IMPORT_COLUMNS } from '@bos/contracts';
import { beforeEach, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const grants = vi.hoisted(() => ({ live: undefined as Map<string, string> | undefined }));
vi.mock('@/lib/grants', async () => {
  const { DEFAULT_ROLE_PERMISSIONS } = await import('@bos/contracts');
  return {
    getGrants: (s: { roles: string[] }) =>
      Promise.resolve(
        grants.live ??
          new Map(
            s.roles.flatMap((r) =>
              Object.entries(DEFAULT_ROLE_PERMISSIONS[r as keyof typeof DEFAULT_ROLE_PERMISSIONS]),
            ),
          ),
      ),
    hasGrant: (g: Map<string, string>, p: string) => g.has(p),
  };
});

const { GET } = await import('./route');
const sales: Session = {
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
const ctx = (kind: string) => ({ params: Promise.resolve({ kind }) });
const req = new Request('https://app.test/imports/customers/template');

beforeEach(() => {
  grants.live = undefined;
  getSession.mockResolvedValue(sales);
});

it('downloads the customer template for a role that may create customers, with private headers', async () => {
  const res = await GET(req, ctx('customers'));
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toBe('text/csv; charset=utf-8');
  expect(res.headers.get('content-disposition')).toBe(
    'attachment; filename="customers-import-template.csv"',
  );
  expect(res.headers.get('cache-control')).toBe('no-store');
  const header = (await res.text()).replace('﻿', '').split('\r\n')[0];
  expect(header).toBe(PARTY_IMPORT_COLUMNS.customer.map((c) => `"${c}"`).join(','));
});

it('refuses a role without the grant of that kind (sales may import customers, not vendors) and an unknown kind', async () => {
  expect((await GET(req, ctx('vendors'))).status).toBe(403);
  expect((await GET(req, ctx('other'))).status).toBe(404);
  getSession.mockResolvedValue(null);
  expect((await GET(req, ctx('customers'))).status).toBe(401);
});
