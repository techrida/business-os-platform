import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import UnassignedPeoplePage from './page';

vi.mock('server-only', () => ({}));
const viewer = vi.hoisted(() => ({
  roles: ['founder'] as string[],
  /** What `GET /v1/me` answers: the saved grants, or `'down'` when the call fails. */
  live: ['admin.roles.write'] as string[] | 'down',
}));
vi.mock('../../guard', () => ({
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
vi.mock('../actions', () => ({
  createDepartmentAction: vi.fn(),
  renameDepartmentAction: vi.fn(),
  retireDepartmentAction: vi.fn(),
  restoreDepartmentAction: vi.fn(),
  previewDepartmentPeopleAction: vi.fn(),
  saveDepartmentPeopleAction: vi.fn(),
  departmentRevisionAction: vi.fn(),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
  usePathname: () => '/settings/departments/unassigned',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const SALES = '00000000-0000-4000-8000-0000000000d1';
const RAM = '00000000-0000-4000-8000-0000000000b1';

const ram = {
  userId: RAM,
  name: 'Ram T.',
  email: 'ram@example.test',
  jobTitle: null,
  roles: ['sales'],
};
const salesDepartment = {
  id: SALES,
  name: 'Sales',
  status: 'active',
  retiredAt: null,
  head: null,
  managers: 0,
  members: 4,
  version: 1,
};

/** Answers the unassigned list with Ram and the department list with Sales. */
function stubApi() {
  const seen: URL[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    if (url.pathname === '/v1/admin/departments/unassigned') {
      return Promise.resolve(Response.json({ items: [ram], total: 1 }));
    }
    return Promise.resolve(Response.json({ items: [salesDepartment], unassigned: 1 }));
  });
  return seen;
}

const render = async () =>
  renderToStaticMarkup(await UnassignedPeoplePage({ searchParams: Promise.resolve({}) }));
const ADD = 'aria-label="Add Ram T. to a department"';
const loadsDepartments = (seen: URL[]) =>
  seen.some((url) => url.pathname === '/v1/admin/departments');

afterEach(() => {
  vi.restoreAllMocks();
  viewer.roles = ['founder'];
  viewer.live = ['admin.roles.write'];
});

it('offers Add to department to a role whose saved grants add admin.roles.write (defaults do not)', async () => {
  viewer.roles = ['sales'];
  viewer.live = ['admin.users.read', 'admin.roles.write'];
  const seen = stubApi();
  const html = await render();
  expect(html).toContain('Ram T.');
  expect(html).toContain(ADD);
  expect(loadsDepartments(seen)).toBe(true);
});

it('hides Add to department from a Founder once admin.roles.write is removed from the saved grants', async () => {
  viewer.roles = ['founder'];
  viewer.live = ['admin.users.read'];
  const seen = stubApi();
  const html = await render();
  expect(html).toContain('Ram T.');
  expect(html).not.toContain(ADD);
  expect(loadsDepartments(seen)).toBe(false);
});

it('falls back to the role defaults when the live grants cannot be read', async () => {
  viewer.live = 'down';
  stubApi();
  expect(await render()).toContain(ADD);
  viewer.roles = ['sales'];
  stubApi();
  expect(await render()).not.toContain(ADD);
});
