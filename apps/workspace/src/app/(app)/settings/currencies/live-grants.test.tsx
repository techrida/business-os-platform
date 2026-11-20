import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTING_DEFAULTS, type SettingKey } from '@bos/contracts';

import type { Session } from '@/lib/session';

// F1-Q48: Finance enters exchange rates (settings.fx_rate.write); which currencies are enabled and how old
// a rate may be stay with the Founder (admin.settings.write). Every persona's live grants differ from its
// role defaults, so these fail on a page or action that reads the roles instead of the grants.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/currencies',
  useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const api = vi.hoisted(() => ({ getSetting: vi.fn(), addFxRate: vi.fn(), listFxRates: vi.fn() }));
vi.mock('@/lib/api-admin', () => ({
  getSetting: api.getSetting,
  putSetting: vi.fn(),
  listFxRates: api.listFxRates,
  addFxRate: api.addFxRate,
}));

const { default: CurrenciesPage } = await import('./page');
const { addFxRateAction } = await import('./actions');
const { IDLE } = await import('../action-state');

/** A staff session whose roles disagree with the live grants `/v1/me` reports for its token. */
function persona(token: string, roles: string[], ...permissions: string[]): Session {
  getMe.mockImplementation((asked) =>
    Promise.resolve(
      asked === token
        ? { permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }
        : {},
    ),
  );
  const session = { accessToken: token, orgKind: 'staff', roles } as Session;
  getSession.mockResolvedValue(session);
  return session;
}

const render = async () => renderToStaticMarkup((await CurrenciesPage()) as ReactElement);

const rateForm = () => {
  const form = new FormData();
  form.set('currency', 'USD');
  form.set('rateNpr', '133.5');
  form.set('rateDate', '2026-11-20');
  return form;
};

beforeEach(() => {
  vi.clearAllMocks();
  api.listFxRates.mockResolvedValue([]);
  api.addFxRate.mockResolvedValue({});
  api.getSetting.mockImplementation((_s: Session, key: SettingKey) =>
    Promise.resolve({ key, value: SETTING_DEFAULTS[key], version: null }),
  );
});

describe('the currencies page by live grant', () => {
  it('opens for an exchange-rate grant with the rate form, without the Founder-only currency settings', async () => {
    persona('fx-holder', ['sales'], 'settings.fx_rate.write');
    const html = await render();
    expect(html).toContain('Add rate');
    expect(html).toContain('Exchange rates');
    expect(html).not.toContain('Currencies in use');
    expect(html).not.toContain('Oldest exchange rate allowed (days)');
    // The Founder-only settings are not even read for this person.
    expect(api.getSetting).not.toHaveBeenCalled();
  });

  it('shows the currency settings and the rate form with admin.settings.write', async () => {
    persona('founder-live', ['sales'], 'admin.settings.write');
    const html = await render();
    expect(html).toContain('Currencies in use');
    expect(html).toContain('Oldest exchange rate allowed (days)');
    expect(html).toContain('Add rate');
  });

  it('hides the currency settings from a Founder whose live grants keep only rate entry', async () => {
    persona('founder-narrowed', ['founder'], 'settings.fx_rate.write');
    const html = await render();
    expect(html).toContain('Add rate');
    expect(html).not.toContain('Currencies in use');
  });

  it('sends a finance-settings holder without the rate grant to Saved terms', async () => {
    persona('accountant', ['accountant'], 'settings.finance.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/terms');
  });

  it('refuses a Founder role whose live grants were all removed', async () => {
    persona('founder-emptied', ['founder']);
    await expect(render()).rejects.toThrow('REDIRECT:/settings/denied');
  });
});

describe('addFxRateAction by live grant', () => {
  it('adds the rate for an exchange-rate grant held by a role without it by default', async () => {
    const session = persona('fx-holder', ['sales'], 'settings.fx_rate.write');
    const state = await addFxRateAction(IDLE, rateForm());
    expect(state.status).toBe('ok');
    expect(api.addFxRate).toHaveBeenCalledWith(session, {
      currency: 'USD',
      rateNpr: '133.5',
      rateDate: '2026-11-20',
      source: 'manual',
    });
  });

  it('refuses a finance-settings holder without the rate grant before any call', async () => {
    persona('accountant', ['accountant'], 'settings.finance.write');
    await expect(addFxRateAction(IDLE, rateForm())).rejects.toThrow('REDIRECT:/settings/terms');
    expect(api.addFxRate).not.toHaveBeenCalled();
  });
});
