import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/tax',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe = vi.fn<() => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (original) => ({
  ...(await original<typeof import('@/lib/api')>()),
  getMe: () => getMe(),
}));
vi.mock('@/lib/api-admin', () => ({
  getSetting: vi.fn(),
  putSetting: vi.fn(),
  listFxRates: vi.fn(),
  listNumberSeries: vi.fn(),
  addFxRate: vi.fn(),
}));

const { default: SettingsLayout } = await import('./layout');
const { default: SettingsIndex } = await import('./page');
const { default: CurrenciesPage } = await import('./currencies/page');
const { default: SalesPage } = await import('./sales/page');
const { default: PurchasingPage } = await import('./purchasing/page');
const { default: NumberingPage } = await import('./numbering/page');
const { default: UsersPage } = await import('./users/page');
const { default: RolesPage } = await import('./access/roles/page');
const { default: WorkflowsPage } = await import('./workflows/page');
const { default: AccessPage } = await import('./access/page');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

const live = (...permissions: string[]) => ({
  permissions: permissions.map((permission) => ({ permission, scope: 'all' })),
});

beforeEach(() => {
  getSession.mockReset();
  getMe.mockReset();
  // Unless a test says otherwise /v1/me is down, so the role defaults decide.
  getMe.mockRejectedValue(new Error('upstream down'));
});

describe('settings pages deny by default', () => {
  it.each([
    ['currencies', () => CurrenciesPage()],
    ['sales', () => SalesPage()],
    ['purchasing', () => PurchasingPage()],
    ['numbering', () => NumberingPage()],
    ['access roles', () => RolesPage()],
    ['workflows', () => WorkflowsPage()],
    ['access', () => AccessPage({ searchParams: Promise.resolve({}) })],
    ['users', () => UsersPage({ searchParams: Promise.resolve({}) })],
    ['the index', () => SettingsIndex()],
  ] as const)('redirects a sales user away from %s', async (_name, render) => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(render()).rejects.toThrow('REDIRECT:/settings/denied');
  });

  it('sends a signed-out visitor from a section to sign in', async () => {
    getSession.mockResolvedValue(null);
    await expect(SalesPage()).rejects.toThrow('REDIRECT:/auth/login?returnTo=%2Fsettings%2Fsales');
  });
});

describe('the founder', () => {
  it('sees the grouped index, one link per ready section, no raw keys', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const html = renderToStaticMarkup((await SettingsIndex()) as ReactElement);
    for (const href of [
      '/settings/users',
      '/settings/access',
      '/settings/workflows',
      '/settings/currencies',
      '/settings/tax',
      '/settings/numbering',
      '/settings/sales',
      '/settings/purchasing',
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    for (const href of [
      '/settings/company',
      '/settings/documents',
      '/settings/formats',
      '/settings/terms',
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    expect(html).toContain('Organisation');
    expect(html).not.toMatch(/version \d|\bfx\.max_rate/);
  });
});

describe('the settings layout', () => {
  const nav = async (roles: string[] | null) => {
    getSession.mockResolvedValue(roles ? session(roles) : null);
    return renderToStaticMarkup((await SettingsLayout({ children: <p>page</p> })) as ReactElement);
  };

  it('renders the section sidebar and active sub-tab strip for the founder', async () => {
    const html = await nav(['founder']);
    expect(html).toContain('<nav aria-label="Settings"');
    expect(html).toContain('aria-label="Finance views"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(2);
    expect(html).toMatch(/aria-current="page" href="\/settings\/currencies"/);
    expect(html).toMatch(
      /aria-current="page"[^>]*href="\/settings\/tax"|href="\/settings\/tax"[^>]*aria-current="page"/,
    );
    expect(html).toContain('href="/settings/users"');
    expect(html).not.toContain('Roles and permissions');
  });

  it('renders no menu for a sales user or a signed-out visitor, but still the page', async () => {
    for (const roles of [['sales'], null]) {
      const html = await nav(roles);
      expect(html).not.toContain('aria-label="Settings"');
      expect(html).toContain('<p>page</p>');
    }
  });

  it('lists the sections a sales role was granted in Settings > Access, and only those', async () => {
    getMe.mockResolvedValue(live('admin.settings.write'));
    const html = await nav(['sales']);
    expect(html).toContain('<nav aria-label="Settings"');
    expect(html).toContain('href="/settings/tax"');
    expect(html).not.toContain('href="/settings/users"');
  });
});

describe('the settings index with live grants', () => {
  it('shows a sales role the section it was granted', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('customer.read', 'admin.users.read'));
    const html = renderToStaticMarkup((await SettingsIndex()) as ReactElement);
    expect(html).toContain('href="/settings/users"');
    expect(html).not.toContain('href="/settings/tax"');
  });

  it('sends that role to the denied page without the grant', async () => {
    getSession.mockResolvedValue(session(['sales']));
    getMe.mockResolvedValue(live('customer.read'));
    await expect(SettingsIndex()).rejects.toThrow('REDIRECT:/settings/denied');
  });
});
