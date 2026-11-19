import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import UsersPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({ requireSession: () => ({ accessToken: 'test-token' }) }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ replace: vi.fn() }) }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

const IDP = '00000000-0000-4000-8000-000000000001';
const DEPARTMENT = '00000000-0000-4000-8000-000000000002';

it('passes directory filters to the API, preserves them across pages, and shows tenant totals', async () => {
  const users = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-9000-${String(index + 1).padStart(12, '0')}`,
    displayName: `Person ${index + 1}`,
    email: `staff+${index}@example.test`,
    idpOrgId: IDP,
    status: 'active',
    roles: ['finance', 'sales'],
    department: { id: DEPARTMENT, name: 'Operations' },
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActiveAt: index === 0 ? '2026-11-19T11:30:00.000Z' : null,
  }));
  const filters = {
    q: 'staff+',
    role: 'finance',
    limit: '5',
    status: 'active',
    departmentId: DEPARTMENT,
    sort: 'lastActive',
  };
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/v1/admin/users/summary') {
      expect(url.search).toBe('');
      return Promise.resolve(
        Response.json({
          total: 80,
          active: 75,
          invited: 4,
          deactivated: 1,
          departments: [{ id: DEPARTMENT, name: 'Operations' }],
          canSendPasswordReset: true,
        }),
      );
    }
    expect(url.pathname).toBe('/v1/admin/users');
    const { page, ...query } = Object.fromEntries(url.searchParams);
    expect(query).toEqual(filters);
    const first = page === '1';
    return Promise.resolve(
      Response.json({
        items: first ? users.slice(0, 5) : users.slice(5),
        nextPage: first ? 2 : null,
        nextAfter: null,
      }),
    );
  });
  try {
    const first = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve(filters) }));
    expect(first).toContain('Person 5');
    expect(first).not.toContain('Person 6');
    expect(first).toContain('Total users');
    expect(first).toContain('Operations');
    expect(first).toContain('datetime="2026-11-19T11:30:00.000Z"');
    expect(first).toContain('Send password reset email to Person 1');
    const link = first.match(/<a[^>]*href="([^"]+)"[^>]*>Next<\/a>/)?.[1];
    expect(link).toBeTruthy();
    const next = new URL(link!.replaceAll('&amp;', '&'), 'https://workspace.test');
    expect(Object.fromEntries(next.searchParams)).toEqual({ ...filters, page: '2' });
    const second = renderToStaticMarkup(
      await UsersPage({ searchParams: Promise.resolve(Object.fromEntries(next.searchParams)) }),
    );
    expect(second).toContain('Person 6');
    expect(second).not.toContain('Person 5');
    expect(second).not.toMatch(/<a[^>]*>Next<\/a>/);
    expect(second).toMatch(/<a[^>]*>Previous<\/a>/);
    expect(second).toContain('Total users');
  } finally {
    request.mockRestore();
  }
});

it('keeps search mounted and shows an empty search result without hiding tenant totals', async () => {
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? {
              total: 8,
              active: 8,
              invited: 0,
              deactivated: 0,
              departments: [],
              canSendPasswordReset: false,
            }
          : { items: [], nextPage: null, nextAfter: null },
      ),
    );
  });
  try {
    const html = renderToStaticMarkup(
      await UsersPage({ searchParams: Promise.resolve({ q: 'missing' }) }),
    );
    expect(html).toContain('No matching users');
    expect(html).toContain('Clear filters');
    expect(html).toContain('Search users');
    expect(html).toContain('Total users');
  } finally {
    request.mockRestore();
  }
});
