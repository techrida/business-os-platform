import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({ redirect: (to: string) => m.redirect(to) }));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));

const { default: NoAccessPage } = await import('./page');

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
  m.redirect.mockClear();
});

// It used to redirect anyone with a session to `/`. For a vendor that looped (`/` sends vendors
// on to /vendor), and for a customer whose landing page the API refused it bounced back here.
describe('/no-access', () => {
  it.each([
    ['without a session', null],
    ['for a signed-in customer', session('customer')],
    ['for a signed-in vendor', session('vendor')],
  ])('renders its notice with a sign-out form %s, and never redirects', async (_label, s) => {
    m.getSession.mockResolvedValue(s);
    // Promise.resolve: the page is synchronous now, but the test holds if it turns async again.
    const html = renderToStaticMarkup((await Promise.resolve(NoAccessPage())) as ReactElement);
    expect(m.redirect).not.toHaveBeenCalled();
    expect(html).toContain('Your account is not set up yet');
    expect(html).toContain('action="/auth/logout"');
    expect(html).toContain('method="post"');
  });
});
