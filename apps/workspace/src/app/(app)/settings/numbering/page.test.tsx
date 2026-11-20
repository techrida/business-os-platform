import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { SETTING_DEFAULTS, type SettingKey } from '@bos/contracts';

import type { Session } from '@/lib/session';

// F1-Q48: Finance or Accountant (settings.finance.write) open Document numbering and save its memo prefix,
// as does the Founder (admin.settings.write). Every persona's live grants differ from its role defaults, so
// these fail on a page or action that reads the roles instead of the grants.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/numbering',
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
const api = vi.hoisted(() => ({
  getSetting: vi.fn(),
  putSetting: vi.fn(),
  listNumberSeries: vi.fn(),
}));
vi.mock('@/lib/api-admin', () => api);

const { default: NumberingPage } = await import('./page');
const { saveSettingsPageAction } = await import('../_components/actions');

/** A staff session whose roles disagree with the live grants `/v1/me` reports for its token. */
function persona(token: string, roles: string[], ...permissions: string[]): void {
  getMe.mockImplementation((asked) =>
    Promise.resolve(
      asked === token
        ? { permissions: permissions.map((permission) => ({ permission, scope: 'all' })) }
        : {},
    ),
  );
  getSession.mockResolvedValue({ accessToken: token, orgKind: 'staff', roles } as Session);
}

const render = async () => renderToStaticMarkup((await NumberingPage()) as ReactElement);

beforeEach(() => {
  vi.clearAllMocks();
  api.getSetting.mockImplementation((_s: Session, key: SettingKey) =>
    Promise.resolve({ key, value: SETTING_DEFAULTS[key], version: null }),
  );
  api.listNumberSeries.mockResolvedValue([
    { key: 'invoice', fiscalYear: '2082/83', prefix: 'INV', nextValue: 7, pad: 5 },
  ]);
});

describe('the Document numbering page by live grant', () => {
  it('opens for a finance-settings grant held by a role without it by default', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    const html = await render();
    expect(html).toContain('Memo number prefix');
    expect(html).toContain('00007');
  });

  it('refuses a Sales role with no settings grant, before any call', async () => {
    persona('sales', ['sales'], 'quotation.read');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.listNumberSeries).not.toHaveBeenCalled();
  });

  it('sends an Accountant role whose live grants keep only rate entry to Currencies', async () => {
    persona('accountant-rates', ['accountant'], 'settings.fx_rate.write');
    await expect(render()).rejects.toThrow('REDIRECT:/settings/currencies');
  });
});

describe('saving the numbering section by live grant', () => {
  it('lets a finance-settings grant through the section guard', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    await expect(saveSettingsPageAction('numbering', [])).resolves.toMatchObject({
      status: 'ok',
    });
  });

  it('refuses a Founder role whose live grants were all removed, before any write', async () => {
    persona('founder-emptied', ['founder']);
    await expect(saveSettingsPageAction('numbering', [])).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(api.putSetting).not.toHaveBeenCalled();
  });
});
