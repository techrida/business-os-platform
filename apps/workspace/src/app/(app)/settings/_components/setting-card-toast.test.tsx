// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

const saveSettingsPageAction = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({
  saveSettingsPageAction,
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));

const { SettingCard } = await import('./setting-card');

const vat: FieldSpec = {
  key: 'tax.vat_rate',
  label: 'Default VAT rate',
  kind: 'percent',
  current: { kind: 'text', value: '13' },
  defaultValue: { kind: 'text', value: '13' },
  version: null,
  defaultText: '13',
  isDefault: true,
  numberBounds: { min: 0, max: 100, step: '0.01' },
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saveSettingsPageAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('SettingCard save toast', () => {
  it('raises the success toast once on save and promotes saved value to baseline', async () => {
    saveSettingsPageAction.mockResolvedValue({
      status: 'ok',
      message: 'Changes saved.',
      saved: [{ key: 'tax.vat_rate', value: { kind: 'text', value: '10' }, version: 1 }],
      fieldErrors: {},
      staleKeys: [],
    });
    const mounted = await mountForm(<SettingCard section="tax" title="Tax" fields={[vat]} />);
    await fill(mounted.container.querySelector('input'), '10');
    await submit(mounted.container);

    expect(saveSettingsPageAction).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Changes saved.', { id: 'settings-page-saved' });
    const saveButton = mounted.container.querySelector<HTMLButtonElement>('button[type="submit"]');
    expect(saveButton?.disabled).toBe(true);
    await mounted.unmount();
  });

  it('keeps refusals on the inline path, keeps the value, and raises an error toast', async () => {
    saveSettingsPageAction.mockResolvedValue({
      status: 'error',
      message: 'Rate must be 0-100.',
      saved: [],
      fieldErrors: { 'tax.vat_rate': 'Rate must be 0-100.' },
      staleKeys: [],
    });
    const mounted = await mountForm(<SettingCard section="tax" title="Tax" fields={[vat]} />);
    const input = mounted.container.querySelector('input');
    await fill(input, '10');
    await submit(mounted.container);

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(input?.value).toBe('10');
    expect(mounted.container.textContent).toContain('Rate must be 0-100.');
    await mounted.unmount();
  });
});
