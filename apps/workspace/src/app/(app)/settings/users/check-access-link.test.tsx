import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import UsersPage from './page';

const guard = vi.hoisted(() => ({ roles: ['founder'] as string[] }));
vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({
  requireSection: () => ({ accessToken: 'test-token', roles: guard.roles }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings/users',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const PERSON = '00000000-0000-4000-9000-000000000001';

function stubDirectory() {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? {
              total: 1,
              active: 1,
              invited: 0,
              deactivated: 0,
              departments: [],
              canSendPasswordReset: false,
            }
          : {
              items: [
                {
                  id: PERSON,
                  displayName: 'Asha Karki',
                  email: null,
                  idpOrgId: '00000000-0000-4000-8000-000000000001',
                  status: 'active',
                  roles: ['sales'],
                  department: null,
                  createdAt: '2026-11-19T00:00:00.000Z',
                  lastActiveAt: null,
                },
              ],
              nextPage: null,
              nextAfter: null,
            },
      ),
    );
  });
}

afterEach(() => {
  guard.roles = ['founder'];
  vi.restoreAllMocks();
});

const renderUsers = async () =>
  renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));

it('offers Check access on each row to people who can read access', async () => {
  stubDirectory();
  const html = await renderUsers();
  expect(html).toContain('aria-label="Check access for Asha Karki"');
  expect(html).toContain(`href="/settings/access/check?person=${PERSON}"`);
});

it('hides Check access from people who cannot read access', async () => {
  guard.roles = ['management'];
  stubDirectory();
  const html = await renderUsers();
  expect(html).toContain('Asha Karki');
  expect(html).not.toContain('Check access');
});
