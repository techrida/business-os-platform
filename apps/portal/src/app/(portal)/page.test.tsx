import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  listPortalQuotations: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: (to: string) => m.redirect(to) }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  listPortalQuotations: m.listPortalQuotations,
}));

const { default: QuotationsPage } = await import('./page');

const session = (orgKind: Session['orgKind']): Session => ({
  id: 's'.repeat(43),
  sub: 'user-1',
  orgId: 'org-1',
  orgKind,
  partyId: '00000000-0000-4000-8000-0000000000aa',
  roles: [],
  accessToken: 'access',
  accessExp: 1_900_000_000,
  createdAt: 1,
  lastSeenAt: 1,
});

beforeEach(() => {
  m.getSession.mockReset();
  m.listPortalQuotations.mockReset();
  m.redirect.mockClear();
});

describe('(portal) landing page', () => {
  it('sends a visitor without a session to sign in', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(QuotationsPage()).rejects.toThrow('NEXT_REDIRECT /auth/login?returnTo=%2F');
    expect(m.listPortalQuotations).not.toHaveBeenCalled();
  });

  // A vendor opening `/` goes to its own screens; it must never reach /no-access or the API.
  it('sends a vendor session to /vendor without calling the API', async () => {
    m.getSession.mockResolvedValue(session('vendor'));
    await expect(QuotationsPage()).rejects.toThrow('NEXT_REDIRECT /vendor');
    expect(m.listPortalQuotations).not.toHaveBeenCalled();
  });

  it('lists the quotations of a customer session', async () => {
    m.getSession.mockResolvedValue(session('customer'));
    m.listPortalQuotations.mockResolvedValue([]);
    await QuotationsPage();
    expect(m.listPortalQuotations).toHaveBeenCalledOnce();
    expect(m.redirect).not.toHaveBeenCalled();
  });
});
