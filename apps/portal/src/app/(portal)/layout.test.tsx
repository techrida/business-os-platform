import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getBranding: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => m.redirect(to),
  usePathname: () => '/',
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api-branding', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-branding')>()),
  getBranding: m.getBranding,
}));

const { default: PortalLayout } = await import('./layout');

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
  m.getBranding.mockReset();
  m.getBranding.mockResolvedValue(null);
  m.redirect.mockClear();
});

describe('(portal) layout', () => {
  it('sends a visitor without a session to sign in', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(PortalLayout({ children: null })).rejects.toThrow(
      'NEXT_REDIRECT /auth/login?returnTo=%2F',
    );
  });

  // P4: a vendor session never sees the customer pages; it goes to the vendor screens.
  it('sends a vendor session to /vendor', async () => {
    m.getSession.mockResolvedValue(session('vendor'));
    await expect(PortalLayout({ children: <p>customer page</p> })).rejects.toThrow(
      'NEXT_REDIRECT /vendor',
    );
  });

  it('renders the customer pages for a customer session', async () => {
    m.getSession.mockResolvedValue(session('customer'));
    const html = renderToStaticMarkup(
      (await PortalLayout({ children: <p>customer page</p> })) as ReactElement,
    );
    expect(m.redirect).not.toHaveBeenCalled();
    expect(html).toContain('customer page');
    expect(html).toContain('action="/auth/logout"');
  });

  // R6Q20: the company logo is in the header, through the same-origin proxy, with the company name as its alt text.
  it('shows the company logo in the top bar, and the product name when there is none', async () => {
    const tenantId = '11111111-1111-4111-8111-111111111111';
    const documentId = '22222222-2222-4222-8222-222222222222';
    m.getSession.mockResolvedValue(session('customer'));
    m.getBranding.mockResolvedValue({ displayName: 'Techrida', logo: { tenantId, documentId } });
    const withLogo = renderToStaticMarkup(
      (await PortalLayout({ children: <p>customer page</p> })) as ReactElement,
    );
    expect(withLogo).toContain(`src="/brand/logo/${tenantId}"`);
    expect(withLogo).toContain('alt="Techrida"');

    m.getBranding.mockResolvedValue({ displayName: 'Techrida', logo: null });
    const nameOnly = renderToStaticMarkup(
      (await PortalLayout({ children: <p>customer page</p> })) as ReactElement,
    );
    expect(nameOnly).not.toContain('<img');
    expect(nameOnly).toContain('Techrida');

    m.getBranding.mockResolvedValue(null);
    const none = renderToStaticMarkup(
      (await PortalLayout({ children: <p>customer page</p> })) as ReactElement,
    );
    expect(none).not.toContain('<img');
    expect(none).toContain('Business OS');
  });
});
