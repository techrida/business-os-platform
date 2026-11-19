import { SETTING_DEFAULTS } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import type { Session } from '@/lib/session';

vi.mock('server-only', () => ({}));
vi.mock('next/navigation', () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
const revalidatePath = vi.fn<(path: string, type?: string) => void>();
vi.mock('next/cache', () => ({
  revalidatePath: (path: string, type?: string) => revalidatePath(path, type),
}));
const getSession = vi.fn<() => Promise<Session | null>>();
vi.mock('@/lib/session', () => ({ getSession: () => getSession() }));
const putSetting =
  vi.fn<
    (
      session: Session,
      key: string,
      value: unknown,
      expectedVersion?: number | null,
    ) => Promise<unknown>
  >();
vi.mock('@/lib/api-admin', () => ({
  putSetting: (session: Session, key: string, value: unknown, expectedVersion?: number | null) =>
    putSetting(session, key, value, expectedVersion),
}));

const { resetSettingAction } = await import('./actions');

const session = (roles: string[], orgKind: Session['orgKind'] = 'staff'): Session =>
  ({ accessToken: 't', orgKind, roles }) as Session;

beforeEach(() => {
  getSession.mockReset();
  putSetting.mockReset();
  putSetting.mockResolvedValue({ version: 2 });
  revalidatePath.mockReset();
});

describe('resetSettingAction', () => {
  it('writes exactly the default of the one setting and refreshes the section and the layout', async () => {
    const founder = session(['founder']);
    getSession.mockResolvedValue(founder);

    await expect(resetSettingAction('tax', 'tax.vat_rate', 4)).resolves.toMatchObject({
      status: 'ok',
    });
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      founder,
      'tax.vat_rate',
      SETTING_DEFAULTS['tax.vat_rate'],
      4,
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings/tax', undefined);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('writes the whole default of an object and of a list setting', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await resetSettingAction('workflows', 'approvals.sla_defaults', 1);
    await resetSettingAction('sales', 'sales.default_schedule', 1);
    await resetSettingAction('currencies', 'currency.enabled', 1);
    expect(putSetting.mock.calls.map(([, key, value]) => [key, value])).toEqual([
      ['approvals.sla_defaults', SETTING_DEFAULTS['approvals.sla_defaults']],
      ['sales.default_schedule', SETTING_DEFAULTS['sales.default_schedule']],
      ['currency.enabled', SETTING_DEFAULTS['currency.enabled']],
    ]);
  });

  it('serves the document style and the saved term sets, which have no editor of their own', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(resetSettingAction('documents', 'document.style', 2)).resolves.toMatchObject({
      status: 'ok',
    });
    await expect(
      resetSettingAction('terms', 'quotation.term_presets', null),
    ).resolves.toMatchObject({ status: 'ok' });
    expect(putSetting.mock.calls.map(([, key]) => key)).toEqual([
      'document.style',
      'quotation.term_presets',
    ]);
  });

  it('refuses the company and formats settings: their own versioned actions reset them', async () => {
    getSession.mockResolvedValue(session(['founder']));
    // Writing the whole company profile would wipe the logo and every card.
    for (const [section, key] of [
      ['company', 'entity.profile'],
      ['company', 'entity.pan_vat_no'],
      ['company', 'entity.address'],
      ['formats', 'format.date'],
      ['formats', 'format.number_systems'],
    ] as const) {
      await expect(resetSettingAction(section, key, 1)).resolves.toMatchObject({
        status: 'error',
        message: 'Unknown settings section.',
      });
    }
    expect(putSetting).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('sends the version the page loaded as the expected version', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await resetSettingAction('tax', 'tax.vat_rate', 7);
    expect(putSetting.mock.calls[0]?.[3]).toBe(7);
  });

  it('sends null when the page loaded the default (nobody had saved the key)', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await resetSettingAction('tax', 'tax.vat_rate', null);
    expect(putSetting.mock.calls[0]?.[3]).toBeNull();
  });

  it('fails closed on a missing or non-integer version, and writes nothing', async () => {
    getSession.mockResolvedValue(session(['founder']));
    for (const bad of [undefined, 1.5, Number.NaN, '3', -Infinity]) {
      await expect(
        resetSettingAction('tax', 'tax.vat_rate', bad as unknown as number),
      ).resolves.toMatchObject({ status: 'error', message: 'Reload the page and try again.' });
    }
    expect(putSetting).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('answers a stale page with the reload message and refreshes nothing', async () => {
    getSession.mockResolvedValue(session(['founder']));
    putSetting.mockRejectedValue({
      status: 409,
      body: { error: { code: 'stale_setting', message: 'stale', correlationId: 'abc-12345' } },
    });
    await expect(resetSettingAction('tax', 'tax.vat_rate', 3)).resolves.toMatchObject({
      status: 'error',
      message: STALE_SETTING_MESSAGE,
    });
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('refuses a user without the section permission and writes nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(resetSettingAction('tax', 'tax.vat_rate', 4)).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(putSetting).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in and writes nothing', async () => {
    getSession.mockResolvedValue(null);
    await expect(resetSettingAction('tax', 'tax.vat_rate', 4)).rejects.toThrow(
      'REDIRECT:/auth/login',
    );
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a customer session', async () => {
    getSession.mockResolvedValue(session(['founder'], 'customer'));
    await expect(resetSettingAction('tax', 'tax.vat_rate', 4)).rejects.toThrow(
      'REDIRECT:/staff-only',
    );
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a key that belongs to another section, and an unknown key or section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(resetSettingAction('tax', 'numbering.memo_prefix', 1)).resolves.toMatchObject({
      status: 'error',
      message: 'Unknown setting.',
    });
    await expect(
      resetSettingAction('tax', 'not.a.setting' as unknown as 'tax.vat_rate', 1),
    ).resolves.toMatchObject({ status: 'error', message: 'Unknown setting.' });
    await expect(resetSettingAction('users', 'tax.vat_rate', 1)).resolves.toMatchObject({
      status: 'error',
      message: 'Unknown settings section.',
    });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('reports a failed write as an error, not a success', async () => {
    getSession.mockResolvedValue(session(['founder']));
    putSetting.mockRejectedValue({ status: 403 });
    const state = await resetSettingAction('tax', 'tax.vat_rate', 4);
    expect(state.status).toBe('error');
    expect(state.message).toContain("You don't have permission to reset this setting");
    expect(revalidatePath).not.toHaveBeenCalledWith('/', 'layout');
  });
});
