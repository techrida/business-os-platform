import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import UsersPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({
  requireSection: () => ({ accessToken: 'test-token', roles: ['founder'] }),
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings/users',
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const ME = '00000000-0000-4000-9000-0000000000aa';
const TENANT = '00000000-0000-4000-8000-0000000000bb';

/** The directory APIs; the identity-review list is never reachable, as in an outage of that endpoint. */
function stub(flagged: number) {
  return vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/v1/admin/users/identity-review') {
      return Promise.reject(new Error('identity-review must not be needed'));
    }
    if (url.pathname === '/v1/me') {
      return Promise.resolve(
        Response.json({
          userId: 'z-me',
          id: ME,
          tenantId: TENANT,
          organizationId: TENANT,
          orgKind: 'staff',
          partyId: null,
          roles: ['founder'],
          correlationId: 'c-1',
        }),
      );
    }
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? {
              total: 3,
              active: 3,
              invited: 0,
              deactivated: 0,
              flagged,
              departments: [],
              canSendPasswordReset: false,
              canChangeStatus: true,
            }
          : { items: [], nextPage: null, nextAfter: null },
      ),
    );
  });
}

afterEach(() => vi.restoreAllMocks());

it('shows the Flagged users link with the count from the summary, without listing the flagged people', async () => {
  stub(2);
  const html = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));
  expect(html).toMatch(/<a[^>]*href="\/settings\/users\/flagged"[^>]*>[^<]*Flagged users \(2\)/);
});

it('keeps the Flagged users link, with no count, when nobody is flagged', async () => {
  stub(0);
  const html = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));
  expect(html).toMatch(/href="\/settings\/users\/flagged"[^>]*>[^<]*Flagged users</);
  expect(html).not.toContain('Flagged users (');
});
