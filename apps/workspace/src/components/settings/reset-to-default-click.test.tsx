// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { STALE_SETTING_MESSAGE } from '@/components/settings/stale-setting';
import { click, mountForm } from '@/test/form-interactions';

const resetSettingAction = vi.hoisted(() => vi.fn());
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/app/(app)/settings/_components/actions', () => ({ resetSettingAction }));
vi.mock('@/components/ui/toast', () => ({ toast }));

const { ResetToDefaultButton } = await import('./reset-to-default');

const props = {
  section: 'tax',
  settingKey: 'tax.vat_rate',
  label: 'Default VAT rate (%)',
  defaultText: '13',
  isDefault: false,
} as const;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  resetSettingAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('ResetToDefaultButton press', () => {
  it('sends the version the page loaded with the reset', async () => {
    resetSettingAction.mockResolvedValue({ status: 'ok', message: 'Reset to default.' });
    const mounted = await mountForm(<ResetToDefaultButton {...props} loadedVersion={6} />);
    await click(mounted.container.querySelector('button'));
    expect(resetSettingAction).toHaveBeenCalledExactlyOnceWith('tax', 'tax.vat_rate', 6);
    expect(toast.success).toHaveBeenCalled();
    await mounted.unmount();
  });

  it('sends null when the page loaded the default', async () => {
    resetSettingAction.mockResolvedValue({ status: 'ok', message: 'Reset to default.' });
    const mounted = await mountForm(<ResetToDefaultButton {...props} loadedVersion={null} />);
    await click(mounted.container.querySelector('button'));
    expect(resetSettingAction).toHaveBeenCalledExactlyOnceWith('tax', 'tax.vat_rate', null);
    await mounted.unmount();
  });

  it('shows the stale message as the error toast, not a success', async () => {
    resetSettingAction.mockResolvedValue({ status: 'error', message: STALE_SETTING_MESSAGE });
    const mounted = await mountForm(<ResetToDefaultButton {...props} loadedVersion={6} />);
    await click(mounted.container.querySelector('button'));
    expect(toast.error).toHaveBeenCalledWith(STALE_SETTING_MESSAGE, expect.anything());
    expect(toast.success).not.toHaveBeenCalled();
    await mounted.unmount();
  });

  it('ignores loadedVersion when a custom action is given', async () => {
    const action = vi.fn().mockResolvedValue({ status: 'ok', message: 'Done.' });
    const mounted = await mountForm(
      <ResetToDefaultButton {...props} loadedVersion={6} action={action} />,
    );
    await click(mounted.container.querySelector('button'));
    expect(action).toHaveBeenCalledOnce();
    expect(resetSettingAction).not.toHaveBeenCalled();
    await mounted.unmount();
  });
});
