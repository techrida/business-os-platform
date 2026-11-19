import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import DepartmentPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('../../guard', () => ({
  requireSection: () => Promise.resolve({ accessToken: 'test-token', roles: ['founder'] }),
}));
const flags = vi.hoisted(() => ({ canWrite: true }));
vi.mock('@/components/p2/customers/permissions', () => ({
  permissionChecker: () => (permission: string) =>
    permission === 'admin.roles.write' ? flags.canWrite : true,
}));
vi.mock('../actions', () => ({
  createDepartmentAction: vi.fn(),
  renameDepartmentAction: vi.fn(),
  retireDepartmentAction: vi.fn(),
  restoreDepartmentAction: vi.fn(),
  previewDepartmentPeopleAction: vi.fn(),
  saveDepartmentPeopleAction: vi.fn(),
  departmentRevisionAction: vi.fn(),
}));
vi.mock('@/components/access/review-changes-dialog', () => ({ ReviewChangesDialog: () => null }));
vi.mock('next/navigation', () => ({
  notFound: () => {
    throw new Error('NEXT_NOT_FOUND');
  },
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/departments',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const SALES = '00000000-0000-4000-8000-0000000000d1';
const ASHA = '00000000-0000-4000-8000-0000000000a1';

const detail = {
  id: SALES,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: { id: ASHA, name: 'Asha K.' },
  managers: 0,
  memberCount: 1,
  members: [
    {
      userId: ASHA,
      name: 'Asha K.',
      email: 'asha@example.com',
      jobTitle: null,
      level: 'head',
      roles: [],
      since: '2026-01-05T00:00:00.000Z',
    },
  ],
  version: 2,
  revision: 'rev-1',
};

/** Answers the department detail with `found` (or 404), the department list and an empty users list. */
function stubApi(found: unknown) {
  const seen: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.pathname === '/v1/admin/users') {
      return Promise.resolve(Response.json({ items: [], nextAfter: null, nextPage: null }));
    }
    if (url.pathname === '/v1/admin/departments') {
      return Promise.resolve(Response.json({ items: [], unassigned: 0 }));
    }
    if (found === null) {
      return Promise.resolve(
        Response.json(
          { error: { code: 'not_found', message: 'Not found.', correlationId: 'c-1' } },
          { status: 404 },
        ),
      );
    }
    return Promise.resolve(Response.json(found));
  });
  return seen;
}

afterEach(() => {
  vi.restoreAllMocks();
  flags.canWrite = true;
});

it('renders the not-found page for an unknown or malformed department id', async () => {
  const seen = stubApi(null);
  await expect(
    DepartmentPage({ params: Promise.resolve({ id: '00000000-0000-4000-8000-0000000000ff' }) }),
  ).rejects.toThrow('NEXT_NOT_FOUND');
  expect(seen.map((url) => url.pathname)).toContain(
    '/v1/admin/departments/00000000-0000-4000-8000-0000000000ff',
  );

  seen.length = 0;
  await expect(DepartmentPage({ params: Promise.resolve({ id: 'sales' }) })).rejects.toThrow(
    'NEXT_NOT_FOUND',
  );
  expect(seen).toHaveLength(0);
});

it('shows a retired department as read only with Restore', async () => {
  stubApi({ ...detail, status: 'retired', retiredAt: '2026-11-01T00:00:00.000Z' });
  const html = renderToStaticMarkup(await DepartmentPage({ params: Promise.resolve({ id: SALES }) }));
  expect(html).toContain('Sales is retired. Its past records stay under Sales.');
  expect(html).toContain('aria-label="Restore Sales"');
  expect(html).toContain('Department head: ');
  expect(html).not.toContain('Review changes');
  expect(html).not.toContain('Add people');
  expect(html).not.toContain('Rename Sales');
});
