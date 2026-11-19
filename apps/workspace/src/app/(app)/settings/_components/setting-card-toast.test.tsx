// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

// A saved change gives the card new current values and the page remounts it, which would drop an effect that
// announces the result: the success toast must come from the save action's own promise.
const saveCardAction = vi.hoisted(() => vi.fn());
vi.mock('./actions', () => ({ saveCardAction, resetSettingAction: vi.fn() }));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));
vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));

const { SettingCard } = await import('./setting-card');

const vat: FieldSpec = {
  key: 'tax.vat_rate',
  label: 'Default VAT rate (%)',
  kind: 'percent',
  current: '13',
  version: null,
  defaultText: '13',
  isDefault: true,
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saveCardAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('SettingCard save toast', () => {
  it('raises the success toast once from the save action', async () => {
    saveCardAction.mockResolvedValue({ status: 'ok', message: 'Changes saved.' });
    const mounted = await mountForm(<SettingCard section="sales" title="Tax" fields={[vat]} />);
    await fill(mounted.container.querySelector('input'), '10');
    await submit(mounted.container);

    expect(saveCardAction).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledTimes(1);
    expect(toast.success).toHaveBeenCalledWith('Changes saved.', { id: 'setting-card-saved' });
    await mounted.unmount();
  });

  it('keeps refusals on the inline path and raises no success toast', async () => {
    saveCardAction.mockResolvedValue({ status: 'error', message: 'Rate must be 0-100.' });
    const mounted = await mountForm(<SettingCard section="sales" title="Tax" fields={[vat]} />);
    await fill(mounted.container.querySelector('input'), '10');
    await submit(mounted.container);

    expect(toast.success).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledTimes(1);
    await mounted.unmount();
  });
});
