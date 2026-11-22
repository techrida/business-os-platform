// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

const saveSettingsPageAction = vi.hoisted(() => vi.fn());
vi.mock('@/app/(app)/settings/_components/actions', () => ({
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

const field = (
  key: FieldSpec['key'],
  version: number | null,
  current: string,
  def: string,
): FieldSpec => ({
  key,
  label: key,
  kind: 'integer',
  current: { kind: 'text', value: current },
  defaultValue: { kind: 'text', value: def },
  version,
  defaultText: def,
  isDefault: current === def,
  numberBounds: { min: 1, max: 10, step: '1' },
});

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saveSettingsPageAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
});

describe('SettingCard expectedVersion tracking', () => {
  it('sends each changed key with its own loaded version (including null) when saving edits or resets', async () => {
    saveSettingsPageAction.mockResolvedValue({
      status: 'ok',
      message: 'Changes saved.',
      saved: [
        { key: 'procurement.min_quotes', value: { kind: 'text', value: '3' }, version: 6 },
        { key: 'procurement.match.qty_pct', value: { kind: 'text', value: '5' }, version: 1 },
      ],
      fieldErrors: {},
      staleKeys: [],
    });

    const mounted = await mountForm(
      <SettingCard
        section="purchasing"
        title="Purchasing"
        fields={[
          field('procurement.min_quotes', 5, '4', '3'),
          {
            key: 'procurement.match.qty_pct',
            label: 'Quantity tolerance (%)',
            kind: 'percent',
            current: { kind: 'text', value: '0' },
            defaultValue: { kind: 'text', value: '0' },
            version: null,
            defaultText: '0',
            isDefault: true,
            numberBounds: { min: 0, max: 100, step: '0.01' },
          },
        ]}
      />,
    );

    // Reset min_quotes to default (stages in form; does not call API yet).
    const resetBtn = mounted.container.querySelector(
      'button[aria-label="Reset procurement.min_quotes to default"]',
    );
    await click(resetBtn);
    expect(saveSettingsPageAction).not.toHaveBeenCalled();

    // Edit qty_pct as well.
    const qtyLabel = Array.from(mounted.container.querySelectorAll('label')).find(
      (l) => l.textContent === 'Quantity tolerance (%)',
    );
    await fill(document.getElementById(qtyLabel?.htmlFor ?? ''), '5');

    await submit(mounted.container);

    expect(saveSettingsPageAction).toHaveBeenCalledExactlyOnceWith('purchasing', [
      {
        key: 'procurement.min_quotes',
        value: { kind: 'text', value: '3' },
        expectedVersion: 5,
      },
      {
        key: 'procurement.match.qty_pct',
        value: { kind: 'text', value: '5' },
        expectedVersion: null,
      },
    ]);

    await mounted.unmount();
  });
});
