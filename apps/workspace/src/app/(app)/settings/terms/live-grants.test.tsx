import type { TermPreset } from '@bos/contracts';
import type { ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/session';

// F1-Q48: Finance or Accountant (settings.finance.write) manage Saved terms, as does the Founder
// (admin.settings.write). Every persona's live grants differ from its role defaults, so these fail on a
// page or action that reads the roles instead of the grants.

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  usePathname: () => '/settings/terms',
  useRouter: () => ({ replace: vi.fn() }),
}));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const getMe =
  vi.fn<(token: string) => Promise<{ permissions?: { permission: string; scope: string }[] }>>();
vi.mock('@/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api')>()),
  getMe: (session: { accessToken: string }) => getMe(session.accessToken),
}));
const api = vi.hoisted(() => ({
  listTermPresets: vi.fn(),
  createTermPreset: vi.fn(),
  updateTermPreset: vi.fn(),
  deleteTermPreset: vi.fn(),
}));
vi.mock('@/lib/api-term-presets', () => api);
const admin = vi.hoisted(() => ({ getSetting: vi.fn(), putSetting: vi.fn() }));
vi.mock('@/lib/api-admin', () => admin);

const { default: TermsPage } = await import('./page');
const { savePresetAction, removePresetAction } = await import('./actions');

const ID = '11111111-1111-4111-8111-111111111111';
const preset: TermPreset = {
  id: ID,
  kind: 'scope',
  name: 'Standard build',
  body: '<p>We build it.</p>',
};
const add = { kind: 'scope', name: 'Standard build', body: 'We build it.' };

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

beforeEach(() => {
  vi.clearAllMocks();
  api.listTermPresets.mockResolvedValue([preset]);
  api.createTermPreset.mockResolvedValue(preset);
  api.deleteTermPreset.mockResolvedValue(undefined);
  admin.getSetting.mockResolvedValue({ key: 'quotation.term_presets', value: [], version: 3 });
});

describe('Saved terms by live grant', () => {
  it('shows the page to a finance-settings grant held by a role without it by default', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('Standard build');
  });

  it('adds and removes a term set for that grant', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    expect(await savePresetAction(add)).toMatchObject({ status: 'ok' });
    expect(api.createTermPreset).toHaveBeenCalledTimes(1);
    expect(await removePresetAction(ID)).toMatchObject({ status: 'ok' });
    expect(api.deleteTermPreset).toHaveBeenCalledWith(expect.anything(), ID);
  });

  it('refuses a Finance role whose live grants keep only rate entry, before any call', async () => {
    persona('finance-rates', ['finance'], 'settings.fx_rate.write');
    await expect(TermsPage()).rejects.toThrow('REDIRECT:/settings/currencies');
    await expect(savePresetAction(add)).rejects.toThrow('REDIRECT:/settings/currencies');
    await expect(removePresetAction(ID)).rejects.toThrow('REDIRECT:/settings/currencies');
    expect(api.createTermPreset).not.toHaveBeenCalled();
    expect(api.deleteTermPreset).not.toHaveBeenCalled();
  });

  it('refuses a Founder role whose live grants were all removed', async () => {
    persona('founder-emptied', ['founder']);
    await expect(savePresetAction(add)).rejects.toThrow('REDIRECT:/settings/denied');
    expect(api.createTermPreset).not.toHaveBeenCalled();
  });
});
