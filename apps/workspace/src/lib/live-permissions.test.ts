import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getMe } from './api';
import { getGrants, grantScope, hasGrant } from './grants';
import { getPermissions } from './live-permissions';

// `server-only` throws outside the react-server condition, which Vitest does not use.
vi.mock('server-only', () => ({}));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  getMe: vi.fn(),
}));
// React `cache` memoizes only inside a server render. This stand-in memoizes on the arguments for the whole file,
// so one access token plays the part of one render pass (each test uses fresh tokens).
vi.mock('react', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const seen = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!seen.has(key)) seen.set(key, fn(...args));
      return seen.get(key) as R;
    };
  },
}));

const me = {
  userId: '312345678901234567',
  tenantId: '00000000-0000-4000-8000-000000000001',
  organizationId: '00000000-0000-4000-8000-000000000002',
  orgKind: 'staff',
  partyId: null,
  roles: ['sales'],
  correlationId: 'req-12345678',
} as const;

let token = 0;
/** A new token per pass: the cache keys on it. */
const session = (roles: string[] = ['sales']) => ({
  accessToken: `eyJ.live-${++token}.sig`,
  roles,
});

beforeEach(() => {
  vi.mocked(getMe).mockReset();
});

describe('one /v1/me read per render pass', () => {
  it('serves the action grants and the page permissions from a single /v1/me call', async () => {
    vi.mocked(getMe).mockResolvedValue({
      ...me,
      permissions: [
        { permission: 'customer.read', scope: 'all' },
        { permission: 'quotation.read', scope: 'own' },
      ],
    } as never);
    const pass = session();

    const [grants, permissions] = await Promise.all([getGrants(pass), getPermissions(pass)]);
    // A second read in the same pass (another component on the page) is answered without a call too.
    await getGrants(pass);

    expect(vi.mocked(getMe)).toHaveBeenCalledTimes(1);
    expect(grantScope(grants, 'quotation.read')).toBe('own');
    expect(hasGrant(grants, 'customer.write')).toBe(false);
    expect([...permissions].sort()).toEqual(['customer.read', 'quotation.read']);
  });

  it('reads /v1/me again for another session', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...me, permissions: [] } as never);

    await getGrants(session());
    await getPermissions(session());

    expect(vi.mocked(getMe)).toHaveBeenCalledTimes(2);
  });
});

describe('when /v1/me fails', () => {
  it('hides action controls (no grants) but keeps the role defaults for sidebar and page entry', async () => {
    vi.mocked(getMe).mockRejectedValue(new Error('connection refused'));
    const pass = session(['sales']);

    const grants = await getGrants(pass);
    const permissions = await getPermissions(pass);

    expect(grants.size).toBe(0);
    // Sales' built-in defaults include these; the failed read must not take them away from navigation.
    expect(permissions).toContain('customer.write');
    expect(permissions).toContain('quotation.draft');
    expect(permissions).not.toContain('admin.roles.read');
  });

  it('treats an answer with no grant list the same way', async () => {
    vi.mocked(getMe).mockResolvedValue({ ...me } as never);
    const pass = session(['sales']);

    expect((await getGrants(pass)).size).toBe(0);
    expect(await getPermissions(pass)).toContain('customer.write');
  });
});
