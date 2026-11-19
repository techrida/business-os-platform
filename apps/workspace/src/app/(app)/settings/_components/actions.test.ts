import { SETTING_DEFAULTS } from '@bos/contracts';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
const putSetting = vi.fn<(session: Session, key: string, value: unknown) => Promise<unknown>>();
vi.mock('@/lib/api-admin', () => ({
  putSetting: (session: Session, key: string, value: unknown) => putSetting(session, key, value),
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

    await expect(resetSettingAction('tax', 'tax.vat_rate')).resolves.toMatchObject({
      status: 'ok',
    });
    expect(putSetting).toHaveBeenCalledTimes(1);
    expect(putSetting).toHaveBeenCalledWith(
      founder,
      'tax.vat_rate',
      SETTING_DEFAULTS['tax.vat_rate'],
    );
    expect(revalidatePath).toHaveBeenCalledWith('/settings/tax', undefined);
    expect(revalidatePath).toHaveBeenCalledWith('/', 'layout');
  });

  it('writes the whole default of an object and of a list setting', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await resetSettingAction('workflows', 'approvals.sla_defaults');
    await resetSettingAction('sales', 'sales.default_schedule');
    await resetSettingAction('currencies', 'currency.enabled');
    expect(putSetting.mock.calls.map(([, key, value]) => [key, value])).toEqual([
      ['approvals.sla_defaults', SETTING_DEFAULTS['approvals.sla_defaults']],
      ['sales.default_schedule', SETTING_DEFAULTS['sales.default_schedule']],
      ['currency.enabled', SETTING_DEFAULTS['currency.enabled']],
    ]);
  });

  it('serves the sections with their own editors', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(resetSettingAction('formats', 'format.date')).resolves.toMatchObject({
      status: 'ok',
    });
    await expect(resetSettingAction('terms', 'quotation.term_presets')).resolves.toMatchObject({
      status: 'ok',
    });
    expect(putSetting.mock.calls.map(([, key]) => key)).toEqual([
      'format.date',
      'quotation.term_presets',
    ]);
  });

  it('refuses a user without the section permission and writes nothing', async () => {
    getSession.mockResolvedValue(session(['sales']));
    await expect(resetSettingAction('tax', 'tax.vat_rate')).rejects.toThrow(
      'REDIRECT:/settings/denied',
    );
    expect(putSetting).not.toHaveBeenCalled();
    expect(revalidatePath).not.toHaveBeenCalled();
  });

  it('sends a signed-out visitor to sign in and writes nothing', async () => {
    getSession.mockResolvedValue(null);
    await expect(resetSettingAction('tax', 'tax.vat_rate')).rejects.toThrow('REDIRECT:/auth/login');
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a customer session', async () => {
    getSession.mockResolvedValue(session(['founder'], 'customer'));
    await expect(resetSettingAction('tax', 'tax.vat_rate')).rejects.toThrow('REDIRECT:/staff-only');
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('refuses a key that belongs to another section, and an unknown key or section', async () => {
    getSession.mockResolvedValue(session(['founder']));
    await expect(resetSettingAction('tax', 'numbering.memo_prefix')).resolves.toMatchObject({
      status: 'error',
      message: 'Unknown setting.',
    });
    await expect(
      resetSettingAction('tax', 'not.a.setting' as unknown as 'tax.vat_rate'),
    ).resolves.toMatchObject({ status: 'error', message: 'Unknown setting.' });
    await expect(resetSettingAction('users', 'tax.vat_rate')).resolves.toMatchObject({
      status: 'error',
      message: 'Unknown settings section.',
    });
    expect(putSetting).not.toHaveBeenCalled();
  });

  it('reports a failed write as an error, not a success', async () => {
    getSession.mockResolvedValue(session(['founder']));
    putSetting.mockRejectedValue({ status: 403 });
    const state = await resetSettingAction('tax', 'tax.vat_rate');
    expect(state.status).toBe('error');
    expect(state.message).toContain("You don't have permission to reset this setting");
    expect(revalidatePath).not.toHaveBeenCalledWith('/', 'layout');
  });
});
