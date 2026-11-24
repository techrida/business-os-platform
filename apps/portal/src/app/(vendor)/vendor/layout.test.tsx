import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { sampleOnboarding } from '@/components/vendor/vendor-fixtures';
import type { Session } from '@/lib/session';

const m = vi.hoisted(() => ({
  getSession: vi.fn(),
  getVendorOnboarding: vi.fn(),
  getBranding: vi.fn(),
  redirect: vi.fn((to: string): never => {
    throw new Error(`NEXT_REDIRECT ${to}`);
  }),
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (to: string) => m.redirect(to),
  usePathname: () => '/vendor',
}));
vi.mock('@/lib/session', () => ({ getSession: m.getSession }));
vi.mock('@/lib/api-branding', () => ({
  getBranding: m.getBranding,
  logoSrc: () => null,
}));
vi.mock('@/lib/api.vendor', () => ({ getVendorOnboarding: m.getVendorOnboarding }));

const { default: VendorLayout } = await import('./layout');

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
  m.getVendorOnboarding.mockReset();
  m.getBranding.mockReset().mockResolvedValue(null);
  m.redirect.mockClear();
});

describe('(vendor) layout', () => {
  it('sends a visitor without a session to sign in and back to /vendor', async () => {
    m.getSession.mockResolvedValue(null);
    await expect(VendorLayout({ children: null })).rejects.toThrow(
      'NEXT_REDIRECT /auth/login?returnTo=%2Fvendor',
    );
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });

  // P4: a customer session never sees the vendor screens, and no vendor API call is made for it.
  it('sends a customer session to / before any vendor API call', async () => {
    m.getSession.mockResolvedValue(session('customer'));
    await expect(VendorLayout({ children: <p>vendor page</p> })).rejects.toThrow('NEXT_REDIRECT /');
    expect(m.redirect).toHaveBeenCalledWith('/');
    expect(m.getVendorOnboarding).not.toHaveBeenCalled();
  });

  it('renders the vendor pages with the vendor top bar for a vendor session', async () => {
    const s = session('vendor');
    m.getSession.mockResolvedValue(s);
    m.getVendorOnboarding.mockResolvedValue(sampleOnboarding());
    const html = renderToStaticMarkup(
      (await VendorLayout({ children: <p>vendor page</p> })) as ReactElement,
    );
    expect(m.redirect).not.toHaveBeenCalled();
    expect(m.getVendorOnboarding).toHaveBeenCalledWith(s);
    expect(html).toContain('vendor page');
    expect(html).toContain('Vendor portal');
  });

  it('reads the company branding while the onboarding read is still pending, not after it', async () => {
    m.getSession.mockResolvedValue(session('vendor'));
    let finishOnboarding: (value: ReturnType<typeof sampleOnboarding>) => void = () => undefined;
    m.getVendorOnboarding.mockReturnValue(
      new Promise((resolve) => {
        finishOnboarding = resolve;
      }),
    );
    const rendering = VendorLayout({ children: <p>vendor page</p> });
    await vi.waitFor(() => expect(m.getBranding).toHaveBeenCalledTimes(1));
    finishOnboarding(sampleOnboarding());
    await rendering;
  });
});
