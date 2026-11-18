import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

import UsersPage from './page';

vi.mock('server-only', () => ({}));
vi.mock('../guard', () => ({ requireSession: () => ({ accessToken: 'test-token' }) }));
vi.mock('@/lib/env', () => ({ getEnv: () => ({ API_INTERNAL_URL: 'http://api.test' }) }));

it('follows the rendered cursor with search and role filters and includes the lookahead user exactly once', async () => {
  const users = Array.from({ length: 6 }, (_, index) => ({
    id: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
    displayName: `Person ${index + 1}`,
    email: index >= 3 ? `staff+${index}@example.test` : null,
    idpOrgId: 'staff',
    status: 'active',
    roles: index === 3 ? ['sales'] : ['finance'],
  }));
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    expect(url.pathname).toBe('/v1/admin/users');
    const start = users.findIndex((user) => user.id === url.searchParams.get('after')) + 1;
    const limit = Number(url.searchParams.get('limit'));
    const items = users.slice(start, start + limit);
    return Promise.resolve(
      Response.json({ items, nextAfter: items.length === limit ? items.at(-1)?.id : null }),
    );
  });
  try {
    const first = renderToStaticMarkup(
      await UsersPage({
        searchParams: Promise.resolve({ q: 'staff+', role: 'finance', limit: '5' }),
      }),
    );
    expect(first).toContain('Person 5');
    expect(first).not.toContain('Person 4');
    expect(first).not.toContain('Person 6');
    expect(first).not.toContain('Total users');
    const link = first.match(/<a[^>]*href="([^"]+)"[^>]*>Next<\/a>/)?.[1];
    expect(link).toBeTruthy();
    const next = new URL(link!.replaceAll('&amp;', '&'), 'https://workspace.test');
    expect(next.searchParams.get('after')).toBe(users[4]?.id);
    const second = renderToStaticMarkup(
      await UsersPage({ searchParams: Promise.resolve(Object.fromEntries(next.searchParams)) }),
    );
    expect(second).toContain('Person 6');
    expect(second).not.toContain('Person 5');
    expect(second).not.toMatch(/<a[^>]*>Next<\/a>/);
    expect(second).toContain('Back to the first page');
    expect(next.searchParams.get('limit')).toBe('5');
    expect(next.searchParams.get('q')).toBe('staff+');
    expect(next.searchParams.get('role')).toBe('finance');
  } finally {
    request.mockRestore();
  }
});
