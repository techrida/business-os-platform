import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

const state = vi.hoisted(() => ({
  pathname: '/settings/tax',
}));

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => state.pathname,
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe = vi.fn<() => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  getMe: () => getMe(),
}));

const { default: SettingsLayout } = await import('../layout');
const { default: SettingsIndexPage } = await import('../page');
const { default: CompanySetupSectionPage } = await import('../company-setup/page');
const { default: OrganisationSectionPage } = await import('../organisation/page');
const { default: FinanceSectionPage } = await import('../finance/page');
const { default: SalesAndPurchasingSectionPage } = await import('../sales-and-purchasing/page');

const staffSession = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const live = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

beforeEach(() => {
  state.pathname = '/settings/tax';
  getSession.mockReset();
  getMe.mockReset();
  getMe.mockRejectedValue(new Error('upstream down'));
});

describe('Settings one-page shell layout', () => {
  const renderLayout = async (pathname: string, roles: string[] | null) => {
    state.pathname = pathname;
    getSession.mockResolvedValue(roles ? staffSession(roles) : null);
    return renderToStaticMarkup(
      (await SettingsLayout({ children: <div>leaf body</div> })) as ReactElement,
    );
  };

  it('shows the four left-hand sections and active sub-tab strip for nested Organisation paths', async () => {
    const html = await renderLayout('/settings/departments/dept-123', ['founder']);

    expect(html).toContain('<nav aria-label="Settings"');
    expect(html).toContain('Company');
    expect(html).toContain('Organisation');
    expect(html).toContain('Finance');
    expect(html).toContain('Sales and purchasing');
    expect(html).not.toContain('People and access');

    // Active left-hand section is Organisation (linked to its first allowed sub-tab /settings/users).
    expect(html).toMatch(/aria-current="page" href="\/settings\/users"[^>]*>.*Organisation/);

    // Sub-tab strip lists all four Organisation sub-tabs with Departments marked active.
    expect(html).toContain('aria-label="Organisation views"');
    expect(html).toContain('href="/settings/users"');
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/settings\/departments"|href="\/settings\/departments"[^>]*aria-current="page"/,
    );
    expect(html).toContain('href="/settings/access"');
    expect(html).toContain('href="/settings/workflows"');

    // Mobile section menu is present and the layout itself adds no H1.
    expect(html).toContain('aria-label="Settings sections"');
    expect(html).toContain('All sections');
    expect(html).not.toContain('<h1');
  });

  it('omits the sub-tab strip on the Settings index and keeps exactly one Settings H1 there', async () => {
    state.pathname = '/settings';
    getSession.mockResolvedValue(staffSession(['founder']));
    const layoutHtml = renderToStaticMarkup(
      (await SettingsLayout({ children: <p>index</p> })) as ReactElement,
    );
    expect(layoutHtml).toContain('<nav aria-label="Settings"');
    expect(layoutHtml).not.toContain('views"');

    const indexHtml = renderToStaticMarkup((await SettingsIndexPage()) as ReactElement);
    expect(indexHtml.match(/<h1\b/g)).toHaveLength(1);
    expect(indexHtml).toMatch(/<h1[^>]*>Settings<\/h1>/);
    expect(indexHtml).toContain('Organisation');
    expect(indexHtml).not.toContain('People and access');
  });

  it('gates left-hand sections and sub-tabs on live grants, hiding disallowed sections and tabs', async () => {
    getMe.mockResolvedValue(live('approvals.groups.write'));
    const html = await renderLayout('/settings/workflows', ['sales']);

    // Only Organisation appears, pointing directly to /settings/workflows (the one allowed sub-tab).
    expect(html).toContain('Organisation');
    expect(html).not.toContain('>Company<');
    expect(html).not.toContain('>Finance<');
    expect(html).not.toContain('Sales and purchasing');

    expect(html).toContain('aria-label="Organisation views"');
    expect(html).toContain('href="/settings/workflows"');
    expect(html).not.toContain('href="/settings/users"');
    expect(html).not.toContain('href="/settings/departments"');
    expect(html).not.toContain('href="/settings/access"');
  });

  it('hides the sub-tab strip when a person lacks permission for the requested section', async () => {
    getMe.mockResolvedValue(live('admin.settings.write'));
    const html = await renderLayout('/settings/users', ['sales']);

    expect(html).toContain('<nav aria-label="Settings"');
    expect(html).not.toContain('Organisation');
    expect(html).not.toContain('aria-label="Organisation views"');
  });

  it('shows no sections and no sub-tab strip to a person with no settings grants (deny by default)', async () => {
    getMe.mockResolvedValue(live('customer.read'));
    const html = await renderLayout('/settings/users', ['sales']);

    expect(html).not.toContain('aria-label="Settings"');
    expect(html).not.toContain('views"');
    expect(html).not.toContain('aria-label="Settings sections"');
    expect(html).toContain('<div>leaf body</div>');
  });
});

describe('Settings section index redirects', () => {
  it.each([
    ['company-setup', '/settings/company', CompanySetupSectionPage],
    ['organisation', '/settings/users', OrganisationSectionPage],
    ['finance', '/settings/currencies', FinanceSectionPage],
    ['sales-and-purchasing', '/settings/sales', SalesAndPurchasingSectionPage],
  ] as const)('sends the founder from /settings/%s to %s', async (_slug, destination, page) => {
    getSession.mockResolvedValue(staffSession(['founder']));
    await expect(page()).rejects.toThrow(`REDIRECT:${destination}`);
  });

  it('picks the first allowed sub-tab inside Organisation from live grants', async () => {
    getSession.mockResolvedValue(staffSession(['sales']));
    getMe.mockResolvedValue(live('approvals.groups.write'));
    await expect(OrganisationSectionPage()).rejects.toThrow('REDIRECT:/settings/workflows');

    getMe.mockResolvedValue(live('admin.roles.read'));
    await expect(OrganisationSectionPage()).rejects.toThrow('REDIRECT:/settings/departments');
  });

  it('falls back to the first allowed sub-tab elsewhere when the requested section is denied', async () => {
    getSession.mockResolvedValue(staffSession(['sales']));
    getMe.mockResolvedValue(live('admin.settings.write'));
    await expect(OrganisationSectionPage()).rejects.toThrow('REDIRECT:/settings/company');
  });

  it('sends a person with no settings grants to /settings/denied', async () => {
    getSession.mockResolvedValue(staffSession(['sales']));
    getMe.mockResolvedValue(live('customer.read'));
    await expect(OrganisationSectionPage()).rejects.toThrow('REDIRECT:/settings/denied');
  });

  it('sends a signed-out visitor to sign in with the section returnTo URL', async () => {
    getSession.mockResolvedValue(null);
    await expect(OrganisationSectionPage()).rejects.toThrow(
      'REDIRECT:/auth/login?returnTo=%2Fsettings%2Forganisation',
    );
  });
});
