// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

// U23-Q5 gap 1: focus stays on the setting after Undo or Reset (the icon button that was clicked
// disappears with the change).

vi.mock('./actions', () => ({
  saveSettingsPageAction: vi.fn(),
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { SettingsForm } = await import('./settings-form');
const { SettingCard } = await import('./setting-card');

const validity = (value: string): FieldSpec => ({
  key: 'quotation.validity_days',
  label: 'Quotation validity (days)',
  kind: 'integer',
  current: { kind: 'text', value },
  defaultValue: { kind: 'text', value: '15' },
  version: 2,
  defaultText: '15',
  isDefault: value === '15',
  numberBounds: { min: 1, max: 365, step: '1' },
});

const sla: FieldSpec = {
  key: 'approvals.sla_defaults',
  label: 'Default reminder and escalation times',
  kind: 'sla',
  current: {
    kind: 'sla',
    value: { remindAfterHours: '24', escalateAfterHours: '72', escalateToRole: 'founder' },
  },
  defaultValue: {
    kind: 'sla',
    value: { remindAfterHours: '24', escalateAfterHours: '72', escalateToRole: 'founder' },
  },
  version: 1,
  defaultText: 'remind after 24 h, escalate after 72 h to founder',
  isDefault: true,
};

const mount = (fields: FieldSpec[], section: 'sales' | 'workflows' = 'sales') =>
  mountForm(
    <SettingsForm section={section} fields={fields}>
      <SettingCard title="Settings" fields={fields} />
    </SettingsForm>,
  );

const byLabel = (root: ParentNode, label: string): HTMLButtonElement | null =>
  root.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);

/** The visible number box a field's `<label>` names (the hidden input beside it posts the value). */
const boxLabelled = (root: HTMLElement, label: string): HTMLInputElement | null => {
  const tag = Array.from(root.querySelectorAll('label')).find((l) => l.textContent === label);
  const box = tag?.htmlFor ? root.ownerDocument.getElementById(tag.htmlFor) : null;
  return box instanceof HTMLInputElement && box.type === 'text' ? box : null;
};

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/settings/sales');
});

describe('focus after Undo and Reset', () => {
  it('moves focus to the field when Undo removes its own button', async () => {
    const mounted = await mount([validity('30')]);
    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '45');
    const undo = byLabel(mounted.container, 'Undo change to Quotation validity (days)');
    undo?.focus();
    await click(undo);
    expect(input?.value).toBe('30');
    expect(byLabel(mounted.container, 'Undo change to Quotation validity (days)')).toBeNull();
    expect(document.activeElement).toBe(input);
    await mounted.unmount();
  });

  it('moves focus to the field when Reset to default removes its own button', async () => {
    const mounted = await mount([validity('30')]);
    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    const reset = byLabel(mounted.container, 'Reset Quotation validity (days) to default');
    reset?.focus();
    await click(reset);
    expect(input?.value).toBe('15');
    expect(byLabel(mounted.container, 'Reset Quotation validity (days) to default')).toBeNull();
    expect(document.activeElement).toBe(input);
    await mounted.unmount();
  });

  it('moves focus to the first input of a group setting', async () => {
    const mounted = await mount([sla], 'workflows');
    const remind = boxLabelled(mounted.container, 'Remind after (hours)');
    expect(remind).not.toBeNull();
    await fill(remind, '12');
    await click(byLabel(mounted.container, `Undo change to ${sla.label}`));
    expect(remind?.value).toBe('24');
    expect(document.activeElement).toBe(remind);
    await mounted.unmount();
  });
});
