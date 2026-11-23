import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, expect, it, vi } from 'vitest';

import FlaggedUsersPage from './page';

const redirect = vi.fn((to: string) => {
  throw new Error(`redirect:${to}`);
});

vi.mock('server-only', () => ({}));
vi.mock('../../guard', () => ({
  requireSection: () => ({ accessToken: 'test-token', roles: ['founder'] }),
}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => redirect(to),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  usePathname: () => '/settings/users/flagged',
}));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const ID = '00000000-0000-4000-9000-000000000001';

function api(summary: Record<string, unknown>, items: unknown[]) {
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/v1/admin/users/summary') return Promise.resolve(Response.json(summary));
    expect(url.pathname).toBe('/v1/admin/users/identity-review');
    return Promise.resolve(Response.json({ items }));
  });
}

const SUMMARY = {
  total: 3,
  active: 2,
  invited: 0,
  deactivated: 1,
  departments: [],
  canSendPasswordReset: true,
  canChangeStatus: true,
};

afterEach(() => vi.restoreAllMocks());

it('lists each flagged person with why and when, and a Resolve action', async () => {
  api(SUMMARY, [
    {
      id: ID,
      email: 'mina@example.test',
      displayName: 'Mina Gurung',
      status: 'inactive',
      flaggedAt: '2026-11-23T04:30:00.000Z',
      reason: 'users.deactivate:phase_b_failed',
    },
  ]);
  const html = renderToStaticMarkup(await FlaggedUsersPage());
  expect(html).toContain('Mina Gurung');
  expect(html).toContain('mina@example.test');
  expect(html).toContain('Deactivating this person failed or timed out in the identity provider');
  expect(html).toContain('dateTime="2026-11-23T04:30:00.000Z"');
  expect(html).toContain('Resolve Mina Gurung · mina@example.test');
});

it('shows an empty state when nobody is flagged', async () => {
  api(SUMMARY, []);
  const html = renderToStaticMarkup(await FlaggedUsersPage());
  expect(html).toContain('No flagged users');
  expect(html).not.toContain('Resolve');
});

it('sends a caller without the account-administration grant back to Users', async () => {
  api({ ...SUMMARY, canChangeStatus: false }, []);
  await expect(FlaggedUsersPage()).rejects.toThrow('redirect:/settings/users');
});
