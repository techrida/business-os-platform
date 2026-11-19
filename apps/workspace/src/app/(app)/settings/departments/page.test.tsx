import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import DepartmentsPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({
  requireSection: () => Promise.resolve({ accessToken: 'test-token', roles: ['founder'] }),
}));
const flags = vi.hoisted(() => ({ canWrite: true }));
vi.mock('@/components/p2/customers/permissions', () => ({
  permissionChecker: () => (permission: string) =>
    permission === 'admin.roles.write' ? flags.canWrite : true,
}));
vi.mock('./actions', () => ({
  createDepartmentAction: vi.fn(),
  renameDepartmentAction: vi.fn(),
  retireDepartmentAction: vi.fn(),
  restoreDepartmentAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/departments',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const SALES = '00000000-0000-4000-8000-0000000000d1';
const ASHA = '00000000-0000-4000-8000-0000000000a1';

const sales = {
  id: SALES,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: { id: ASHA, name: 'Asha K.' },
  managers: 2,
  members: 9,
  version: 3,
};

/** Answers the department list with `items` and the users list with nobody. */
function stubApi(items: unknown[], unassigned = 0) {
  const seen: URL[] = [];
  const spy = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.pathname === '/v1/admin/users') {
      return Promise.resolve(Response.json({ items: [], nextAfter: null, nextPage: null }));
    }
    return Promise.resolve(Response.json({ items, unassigned }));
  });
  return { seen, spy };
}

afterEach(() => {
  vi.restoreAllMocks();
  flags.canWrite = true;
});

it("shows each department with the API's counts, the No department row and named actions", async () => {
  const { seen } = stubApi([sales], 7);
  const html = renderToStaticMarkup(
    await DepartmentsPage({ searchParams: Promise.resolve({ q: 'sal', status: 'active' }) }),
  );
  const listCall = seen.find((url) => url.searchParams.get('q') === 'sal');
  expect(listCall?.pathname).toBe('/v1/admin/departments');
  expect(listCall?.searchParams.getAll('status')).toEqual(['active']);
  expect(html).toContain(`href="/settings/departments/${SALES}"`);
  expect(html).toContain('Asha K.');
  expect(html).toMatch(/>2<\/td>/);
  expect(html).toMatch(/>9<\/td>/);
  expect(html).toContain('2 managers · 9 members');
  expect(html).toContain('No department');
  expect(html).toContain('7 people');
  expect(html).toContain('href="/settings/departments/unassigned"');
  expect(html).toContain('aria-label="Rename Sales"');
  expect(html).toContain('aria-label="Retire Sales"');
  expect(html).toContain('aria-label="More actions for Sales"');
  expect(html).toContain('New department');
});
