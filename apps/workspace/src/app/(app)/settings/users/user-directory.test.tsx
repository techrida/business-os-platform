import { avatarColour, imagePath } from '@bos/contracts';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it, vi } from 'vitest';

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
  // The URL repeats status and role; the API gets the same repeated params.
  const filters = {
    q: 'staff+',
    role: ['finance', 'sales'],
    rows: '5',
    status: ['active', 'invited'],
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
    const { searchParams } = url;
    expect(searchParams.getAll('role')).toEqual(['finance', 'sales']);
    expect(searchParams.getAll('status')).toEqual(['active', 'invited']);
    expect(searchParams.get('limit')).toBe('5');
    expect(searchParams.get('q')).toBe('staff+');
    expect(searchParams.get('departmentId')).toBe(DEPARTMENT);
    expect(searchParams.get('sort')).toBe('lastActive');
    const first = searchParams.get('page') === '1';
    // The total counts every match of the filters, not the tenant's 80 users.
    return Promise.resolve(
      Response.json(
        {
          items: first ? users.slice(0, 5) : users.slice(5),
          nextPage: first ? 2 : null,
          nextAfter: null,
        },
        { headers: { 'x-total-count': String(users.length) } },
      ),
    );
  });
  try {
    const first = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve(filters) }));
    expect(first).toContain('Person 5');
    expect(first).not.toContain('Person 6');
    expect(first).toContain('Total users');
    expect(first).toMatch(/Total users[\s\S]*?>80</);
    expect(first).toContain('Showing 1–5 of 6');
    expect(first).toMatch(/aria-label="Page 2"/);
    expect(first).toContain('Operations');
    expect(first).toMatch(/datetime="2026-11-19T11:30:00\.000Z"/i);
    expect(first).toContain('Send password reset email to Person 1');
    const link = first.match(/<a[^>]*href="([^"]+)"[^>]*>Next<\/a>/)?.[1];
    expect(link).toBeTruthy();
    const next = new URL(link!.replaceAll('&amp;', '&'), 'https://workspace.test');
    expect(next.searchParams.getAll('status')).toEqual(['active', 'invited']);
    expect(next.searchParams.getAll('role')).toEqual(['finance', 'sales']);
    expect(next.searchParams.get('rows')).toBe('5');
    expect(next.searchParams.get('page')).toBe('2');
    const second = renderToStaticMarkup(
      await UsersPage({
        searchParams: Promise.resolve({
          ...filters,
          page: next.searchParams.get('page')!,
        }),
      }),
    );
    expect(second).toContain('Person 6');
    expect(second).not.toContain('Person 5');
    expect(second).not.toMatch(/<a[^>]*>Next<\/a>/);
    expect(second).toMatch(/<a[^>]*>Previous<\/a>/);
    expect(second).toContain('Showing 6–6 of 6');
    expect(second).toMatch(/aria-current="page"[^>]*>2</);
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
    expect(html).toContain('Nothing matches Search “missing”.');
    expect(html).toContain('Search users');
    expect(html).not.toContain('Apply');
    expect(html).toContain('Total users');
  } finally {
    request.mockRestore();
  }
});

it('names every active filter in the empty state and the clear link keeps rows and sort', async () => {
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
              departments: [{ id: DEPARTMENT, name: 'Operations' }],
              canSendPasswordReset: false,
            }
          : { items: [], nextPage: null, nextAfter: null },
      ),
    );
  });
  try {
    const html = renderToStaticMarkup(
      await UsersPage({
        searchParams: Promise.resolve({
          status: ['active', 'invited'],
          role: 'finance',
          departmentId: DEPARTMENT,
          rows: '10',
          sort: 'createdAt',
        }),
      }),
    );
    expect(html).toContain('Status: Active, Invited');
    expect(html).toContain('Role: Finance');
    expect(html).toContain('Department: Operations');
    const clear = html.match(/<a[^>]*href="([^"]+)"[^>]*>Clear filters<\/a>/)?.[1];
    expect(clear).toBe('/settings/users?rows=10&amp;sort=createdAt');
  } finally {
    request.mockRestore();
  }
});

it('ignores a stale id cursor from an older link', async () => {
  const seen: URL[] = [];
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    seen.push(url);
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? {
              total: 0,
              active: 0,
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
    await UsersPage({ searchParams: Promise.resolve({ after: DEPARTMENT, status: 'active' }) });
    const list = seen.find((url) => url.pathname === '/v1/admin/users')!;
    expect(list.searchParams.has('after')).toBe(false);
  } finally {
    request.mockRestore();
  }
});

it('gives each row avatar its user id colour and picture, and a picture button named for the person', async () => {
  const PICTURED = '00000000-0000-4000-9000-00000000000a';
  const PLAIN = '00000000-0000-4000-9000-00000000000b';
  const PICTURE = '00000000-0000-4000-a000-0000000000ff';
  const row = (id: string, displayName: string, avatarDocumentId?: string | null) => ({
    id,
    displayName,
    email: `${displayName.toLowerCase()}@example.test`,
    idpOrgId: IDP,
    status: 'active',
    roles: [],
    department: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActiveAt: null,
    ...(avatarDocumentId === undefined ? {} : { avatarDocumentId }),
  });
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? {
              total: 2,
              active: 2,
              invited: 0,
              deactivated: 0,
              departments: [],
              canSendPasswordReset: false,
            }
          : {
              // One row with a picture, one whose API answer omits the field (an older API).
              items: [row(PICTURED, 'Asha', PICTURE), row(PLAIN, 'Bikash')],
              nextPage: null,
              nextAfter: null,
            },
      ),
    );
  });
  try {
    const html = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));
    const avatars = html.match(/style="--avatar-fill:[^"]*" aria-hidden="true">.*?<\/span>/g) ?? [];
    expect(avatars).toHaveLength(2);
    expect(avatars[0]).toContain(`--avatar-fill:${avatarColour(PICTURED)}`);
    expect(avatars[0]).toContain(`src="${imagePath(PICTURE)}"`);
    expect(avatars[1]).toContain(`--avatar-fill:${avatarColour(PLAIN)}`);
    expect(avatars[1]).not.toContain('<img');
    expect(html).toContain('aria-label="Change Asha picture"');
    expect(html).toContain('aria-label="Change Bikash picture"');
  } finally {
    request.mockRestore();
  }
});

it('offers Lock, Deactivate, Unlock and Reactivate to a company-wide admin, never on their own row or an invite (F1-Q5, F1-Q4)', async () => {
  const ME = '00000000-0000-4000-9000-0000000000a1';
  const row = (
    id: string,
    displayName: string,
    status: string,
    lock: { lockReason: string; lockedUntil: string | null } | null = null,
  ) => ({
    id,
    displayName,
    email: `${displayName.toLowerCase()}@example.test`,
    idpOrgId: IDP,
    status,
    ...(lock ?? {}),
    roles: [],
    department: null,
    createdAt: '2026-11-19T00:00:00.000Z',
    lastActiveAt: null,
  });
  const summary = (canChangeStatus: boolean) => ({
    total: 4,
    active: 2,
    invited: 1,
    deactivated: 1,
    departments: [],
    canSendPasswordReset: false,
    canChangeStatus,
  });
  let canChange = true;
  const request = vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (url.pathname === '/v1/me') {
      return Promise.resolve(
        Response.json({
          userId: '312345678901234567',
          id: ME,
          tenantId: '00000000-0000-4000-8000-0000000000f1',
          organizationId: '00000000-0000-4000-8000-0000000000f2',
          orgKind: 'staff',
          partyId: null,
          roles: ['founder'],
          correlationId: 'corr-12345678',
          permissions: [{ permission: 'admin.users.read', scope: 'all' }],
        }),
      );
    }
    return Promise.resolve(
      Response.json(
        url.pathname.endsWith('/summary')
          ? summary(canChange)
          : {
              items: [
                row(ME, 'Founder', 'active'),
                row('00000000-0000-4000-9000-0000000000a2', 'Asha', 'active'),
                row('00000000-0000-4000-9000-0000000000a3', 'Bikash', 'inactive'),
                row('00000000-0000-4000-9000-0000000000a4', 'Chandra', 'invited'),
                row('00000000-0000-4000-9000-0000000000a5', 'Dipesh', 'inactive', {
                  lockReason: 'failed_sign_ins',
                  lockedUntil: '2026-11-20T10:15:00.000Z',
                }),
                row('00000000-0000-4000-9000-0000000000a6', 'Esha', 'inactive', {
                  lockReason: 'admin',
                  lockedUntil: null,
                }),
              ],
              nextPage: null,
              nextAfter: null,
            },
      ),
    );
  });
  try {
    const html = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(html).toContain('aria-label="Deactivate Asha · asha@example.test"');
    expect(html).toContain('aria-label="Lock Asha · asha@example.test"');
    expect(html).toContain('aria-label="Reactivate Bikash · bikash@example.test"');
    expect(html).not.toContain('aria-label="Lock Bikash · bikash@example.test"');
    expect(html).not.toContain('aria-label="Unlock Bikash · bikash@example.test"');
    // Their own row and an invite keep every slot, muted with the reason, and offer nothing live.
    expect(html).not.toMatch(
      /aria-label="(Deactivate|Lock) (Founder|Chandra) · [^"]*@example\.test"/,
    );
    expect(html).not.toMatch(
      /aria-label="(Deactivate|Reactivate|Lock|Unlock) Chandra · [^"]*@example\.test"/,
    );
    expect(html).toContain('aria-label="Lock Founder · founder@example.test (unavailable)"');
    expect(html).toContain('aria-label="Lock Chandra · chandra@example.test (unavailable)"');
    expect(html).toContain('>Deactivated<');
    // A locked person is unlocked, never reactivated; a timed lock shows when it ends.
    expect(html).toContain('aria-label="Unlock Dipesh · dipesh@example.test"');
    expect(html).toContain('aria-label="Unlock Esha · esha@example.test"');
    expect(html).not.toMatch(/aria-label="(Reactivate|Lock) (Dipesh|Esha) · [^"]*@example\.test"/);
    // A locked person can be deactivated (P2-2). Keep locked is no row button; it sits in the Unlock dialog.
    expect(html).toContain('aria-label="Deactivate Dipesh · dipesh@example.test"');
    expect(html).toContain('aria-label="Deactivate Esha · esha@example.test"');
    expect(html).not.toContain('Keep locked');
    expect(html.match(/>Locked</g)).toHaveLength(2);
    expect(html).toContain('dateTime="2026-11-20T10:15:00.000Z"');

    canChange = false;
    const plain = renderToStaticMarkup(await UsersPage({ searchParams: Promise.resolve({}) }));
    expect(plain).not.toMatch(/aria-label="(Deactivate|Reactivate|Lock|Unlock) /);
    // No status grant: nothing about those actions shows (no muted hint either), but their slots stay reserved.
    expect(plain).not.toContain('data-tooltip');
    expect(plain.match(/data-slot="toggle"/g)).toHaveLength(6);
  } finally {
    request.mockRestore();
  }
});
