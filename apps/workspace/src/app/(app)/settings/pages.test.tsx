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
const { default: RolesPage } = await import('./roles/page');
const { default: WorkflowsPage } = await import('./workflows/page');
const { saveCardAction } = await import('./_components/actions');
const { IDLE } = await import('./action-state');

const session = (roles: string[]): Session =>
  ({ accessToken: 't', orgKind: 'staff', roles }) as Session;

beforeEach(() => getSession.mockReset());

describe('settings pages deny by default', () => {
  it.each([
    ['currencies', () => CurrenciesPage()],
    ['sales', () => SalesPage()],
    ['purchasing', () => PurchasingPage()],
    ['numbering', () => NumberingPage()],
    ['roles', () => RolesPage()],
    ['workflows', () => WorkflowsPage()],
    ['users', () => UsersPage({ searchParams: Promise.resolve({}) })],
    ['the index', () => SettingsIndex()],
  ] as const)('redirects a sales user away from %s', async (_name, render) => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(render()).rejects.toThrow('REDIRECT:/no-access');
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
      '/settings/roles',
      '/settings/workflows',
      '/settings/currencies',
      '/settings/tax',
      '/settings/numbering',
      '/settings/sales',
      '/settings/purchasing',
    ]) {
      expect(html).toContain(`href="${href}"`);
    }
    // The four sections other workers are building are not linked until they are ready.
    expect(html).not.toContain('/settings/company');
    expect(html).toContain('People and access');
    expect(html).not.toMatch(/version \d|\bfx\.max_rate/);
  });
});

describe('the settings layout', () => {
  const nav = async (roles: string[] | null) => {
    getSession.mockResolvedValue(roles ? session(roles) : null);
    return renderToStaticMarkup((await SettingsLayout({ children: <p>page</p> })) as ReactElement);
  };

  it('renders a labelled sub-sidebar with the active section marked, for the founder', async () => {
    const html = await nav(['founder']);
    expect(html).toContain('<nav aria-label="Settings"');
    expect(html.match(/aria-current="page"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-current="page" href="\/settings\/tax"/);
    expect(html).toContain('Roles and permissions');
  });

  it('renders no menu for a sales user or a signed-out visitor, but still the page', async () => {
    for (const roles of [['sales'], null]) {
      const html = await nav(roles);
      expect(html).not.toContain('aria-label="Settings"');
      expect(html).toContain('<p>page</p>');
    }
  });
});

describe('saveCardAction', () => {
  const form = (entries: [string, string][]) => {
    const data = new FormData();
    for (const [k, v] of entries) data.append(k, v);
    return data;
  };

  it('refuses a key the section does not own, and an unknown section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const wrongKey = form([
      ['section', 'sales'],
      ['key', 'procurement.min_quotes'],
      ['v:procurement.min_quotes', '5'],
      ['i:procurement.min_quotes', '3'],
    ]);
    expect((await saveCardAction(IDLE, wrongKey)).status).toBe('error');
    expect((await saveCardAction(IDLE, form([['section', 'constructor']]))).status).toBe('error');
  });

  it('refuses a person without the section permission', async () => {
    getSession.mockResolvedValue(session(['sales']));
    const data = form([
      ['section', 'sales'],
      ['key', 'quotation.validity_days'],
      ['v:quotation.validity_days', '20'],
      ['i:quotation.validity_days', '15'],
    ]);
    await expect(saveCardAction(IDLE, data)).rejects.toThrow('REDIRECT:/no-access');
  });

  it('shows a refused value at its field and writes nothing', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const { putSetting } = await import('@/lib/api-admin');
    const data = form([
      ['section', 'sales'],
      ['key', 'quotation.validity_days'],
      ['v:quotation.validity_days', 'abc'],
      ['i:quotation.validity_days', '15'],
    ]);
    const result = await saveCardAction(IDLE, data);
    expect(result.status).toBe('error');
    expect(result.fieldErrors?.['quotation.validity_days']).toBeTruthy();
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('writes only the keys that changed', async () => {
    getSession.mockResolvedValue(session(['founder']));
    const { putSetting } = await import('@/lib/api-admin');
    vi.mocked(putSetting).mockResolvedValue({ version: 2 });
    const data = form([
      ['section', 'purchasing'],
      ['key', 'procurement.match.qty_pct'],
      ['v:procurement.match.qty_pct', '1'],
      ['i:procurement.match.qty_pct', '0'],
      ['key', 'procurement.match.price_pct'],
      ['v:procurement.match.price_pct', '2'],
      ['i:procurement.match.price_pct', '2'],
    ]);
    expect((await saveCardAction(IDLE, data)).status).toBe('ok');
    expect(vi.mocked(putSetting).mock.calls.map(([, key, value]) => [key, value])).toEqual([
      ['procurement.match.qty_pct', '1'],
    ]);
  });
});
