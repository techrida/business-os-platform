import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import DepartmentsPage from './page';

vi.mock('server-only', () => ({}));
const viewer = vi.hoisted(() => ({
  roles: ['founder'] as string[],
  /** What `GET /v1/me` answers: the saved grants, or `'down'` when the call fails. */
  live: ['admin.roles.write'] as string[] | 'down',
}));
vi.mock('../guard', () => ({
  requireSection: () => Promise.resolve({ accessToken: 'test-token', roles: viewer.roles }),
}));
// The real live-permissions helpers run; only the /v1/me call is answered here.
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: () =>
    viewer.live === 'down'
      ? Promise.reject(new Error('upstream down'))
      : Promise.resolve({
          permissions: viewer.live.map((permission) => ({ permission, scope: 'all' })),
        }),
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
  viewer.roles = ['founder'];
  viewer.live = ['admin.roles.write'];
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

it('hides New department and every row action when the viewer may only read', async () => {
  viewer.live = ['admin.users.read'];
  const { seen } = stubApi([sales], 7);
  const html = renderToStaticMarkup(await DepartmentsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('Sales');
  expect(html).not.toContain('New department');
  expect(html).not.toContain('Rename Sales');
  expect(html).not.toContain('Retire Sales');
  expect(html).not.toContain('More actions for Sales');
  expect(seen.some((url) => url.pathname === '/v1/admin/users')).toBe(false);
});

it('says no department matches a search and links back without the search', async () => {
  stubApi([]);
  const html = renderToStaticMarkup(
    await DepartmentsPage({ searchParams: Promise.resolve({ q: 'slaes', status: 'retired' }) }),
  );
  expect(html).toContain('No department matches &#x27;slaes&#x27;.');
  const clear = html.match(/<a[^>]*href="([^"]+)"[^>]*>Clear search<\/a>/)?.[1];
  expect(clear?.replaceAll('&amp;', '&')).toBe('/settings/departments?status=retired');
});

it('offers New department in the empty state when there are no departments', async () => {
  stubApi([]);
  const html = renderToStaticMarkup(await DepartmentsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('No departments yet.');
  expect(html).toContain('Add your first department, then add its people.');
  expect(html.match(/New department/g)).toHaveLength(1);
});

it('opens the actions to a role whose saved grants add admin.roles.write (defaults do not)', async () => {
  viewer.roles = ['sales'];
  viewer.live = ['admin.users.read', 'admin.roles.write'];
  const { seen } = stubApi([sales], 7);
  const html = renderToStaticMarkup(await DepartmentsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('New department');
  expect(html).toContain('aria-label="Rename Sales"');
  expect(seen.some((url) => url.pathname === '/v1/admin/users')).toBe(true);
});

it('shuts the actions for a Founder once admin.roles.write is removed from the saved grants', async () => {
  viewer.roles = ['founder'];
  viewer.live = ['admin.users.read'];
  const { seen } = stubApi([sales], 7);
  const html = renderToStaticMarkup(await DepartmentsPage({ searchParams: Promise.resolve({}) }));
  expect(html).toContain('Sales');
  expect(html).not.toContain('New department');
  expect(html).not.toContain('Rename Sales');
  expect(seen.some((url) => url.pathname === '/v1/admin/users')).toBe(false);
});

it('falls back to the role defaults when the live grants cannot be read', async () => {
  viewer.live = 'down';
  stubApi([sales], 7);
  const founder = renderToStaticMarkup(
    await DepartmentsPage({ searchParams: Promise.resolve({}) }),
  );
  expect(founder).toContain('New department');
  viewer.roles = ['sales'];
  stubApi([sales], 7);
  const salesHtml = renderToStaticMarkup(
    await DepartmentsPage({ searchParams: Promise.resolve({}) }),
  );
  expect(salesHtml).not.toContain('New department');
});
