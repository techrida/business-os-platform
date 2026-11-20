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
const master = vi.hoisted(() => ({
  listAdminPaymentTerms: vi.fn(),
  createPaymentTerm: vi.fn(),
  updatePaymentTerm: vi.fn(),
}));
vi.mock('@/lib/api-master-data', () => master);
const admin = vi.hoisted(() => ({ getSetting: vi.fn(), putSetting: vi.fn() }));
vi.mock('@/lib/api-admin', () => admin);

const { default: TermsPage } = await import('./page');
const { savePresetAction, removePresetAction } = await import('./actions');
const { addPaymentTermAction, renamePaymentTermAction, setPaymentTermRetiredAction } =
  await import('./payment-term-actions');

const ID = '11111111-1111-4111-8111-111111111111';
const preset: TermPreset = {
  id: ID,
  kind: 'scope',
  name: 'Standard build',
  body: '<p>We build it.</p>',
};
const add = { kind: 'scope', name: 'Standard build', body: 'We build it.' };
const NET30 = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'NET30',
  name: 'Net 30',
  netDays: 30,
  retired: false,
  version: 2,
};

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
  master.listAdminPaymentTerms.mockResolvedValue([NET30]);
  master.createPaymentTerm.mockResolvedValue(NET30);
  master.updatePaymentTerm.mockResolvedValue(NET30);
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

// F1-Q49: payment terms are edited on the same page, under the same grant.
describe('Payment terms by live grant', () => {
  it('shows the terms and their days to a finance-settings grant held by a Sales role', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    const html = renderToStaticMarkup((await TermsPage()) as ReactElement);
    expect(html).toContain('Net 30');
    expect(html).toContain('Due in 30 days');
    expect(html).toContain('Add payment term');
  });

  it('adds, renames and retires a term for that grant, never sending new days on an edit', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    await expect(
      addPaymentTermAction({ code: 'net45', name: 'Net 45', netDays: '45' }),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(master.createPaymentTerm).toHaveBeenCalledWith(expect.anything(), {
      code: 'NET45',
      name: 'Net 45',
      netDays: 45,
    });
    await expect(renamePaymentTermAction(NET30.id, 'Net 30 days', 2)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(master.updatePaymentTerm).toHaveBeenLastCalledWith(expect.anything(), NET30.id, {
      name: 'Net 30 days',
      expectedVersion: 2,
    });
    await expect(setPaymentTermRetiredAction(NET30.id, true, 3)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(master.updatePaymentTerm).toHaveBeenLastCalledWith(expect.anything(), NET30.id, {
      retired: true,
      expectedVersion: 3,
    });
  });

  it('refuses days that are not a whole number from 0 to 365 without calling the API', async () => {
    persona('accountant-live', ['sales'], 'settings.finance.write');
    for (const netDays of ['', '400', '1.5', '-1']) {
      const state = await addPaymentTermAction({ code: 'X', name: 'X', netDays });
      expect(state.status, netDays).toBe('error');
    }
    expect(master.createPaymentTerm).not.toHaveBeenCalled();
  });

  it('refuses a Finance role whose live grants keep only rate entry, before any call', async () => {
    persona('finance-rates', ['finance'], 'settings.fx_rate.write');
    await expect(
      addPaymentTermAction({ code: 'NET45', name: 'Net 45', netDays: '45' }),
    ).rejects.toThrow('REDIRECT:/settings/currencies');
    await expect(setPaymentTermRetiredAction(NET30.id, true, 2)).rejects.toThrow('REDIRECT:');
    expect(master.createPaymentTerm).not.toHaveBeenCalled();
    expect(master.updatePaymentTerm).not.toHaveBeenCalled();
  });
});
