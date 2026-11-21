// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, submit } from '@/test/form-interactions';

import type { FieldSpec } from './setting-fields';

// U23-Q5 gap 2: the reminder and billing groups announce their error to screen readers and mark
// their own inputs invalid.

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

const schedule: FieldSpec = {
  key: 'sales.default_schedule',
  label: 'Default billing schedule',
  kind: 'schedule',
  current: {
    kind: 'schedule',
    rows: [
      { label: 'Advance', percent: '60', trigger: 'advance' },
      { label: 'Final', percent: '40', trigger: 'uat' },
    ],
  },
  defaultValue: {
    kind: 'schedule',
    rows: [
      { label: 'Advance', percent: '60', trigger: 'advance' },
      { label: 'Final', percent: '40', trigger: 'uat' },
    ],
  },
  version: 1,
  defaultText: 'Advance 60%, Final 40%',
  isDefault: true,
};

const mount = (fields: FieldSpec[], section: 'sales' | 'workflows' = 'sales') =>
  mountForm(
    <SettingsForm section={section} fields={fields}>
      <SettingCard title="Settings" fields={fields} />
    </SettingsForm>,
  );

/** The visible number boxes the fields' `<label>`s name (each hidden input beside one posts the value). */
const boxesLabelled = (root: HTMLElement, ...labels: string[]): HTMLInputElement[] =>
  Array.from(root.querySelectorAll('label'))
    .filter((tag) => labels.includes(tag.textContent ?? ''))
    .map((tag) => root.ownerDocument.getElementById(tag.htmlFor))
    .filter(
      (box): box is HTMLInputElement => box instanceof HTMLInputElement && box.type === 'text',
    );

const HOURS = ['Remind after (hours)', 'Escalate after (hours)'];

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  window.history.replaceState(null, '', '/settings/sales');
});

describe('grouped errors are announced', () => {
  it('keeps a live region in the reminder group before any error, then fills it and marks the inputs', async () => {
    const mounted = await mount([sla], 'workflows');
    const group = mounted.container.querySelector('[role="group"]');
    const region = group?.querySelector('[role="alert"]');
    // Present and empty before the error, so a screen reader is already listening when it fills.
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');

    const inputs = boxesLabelled(mounted.container, ...HOURS);
    expect(inputs).toHaveLength(2);
    await fill(inputs[0] ?? null, '');
    await submit(mounted.container);

    expect(region?.isConnected).toBe(true);
    expect(region?.textContent).not.toBe('');
    const regionId = region?.getAttribute('id') ?? '';
    expect(regionId).not.toBe('');
    expect(group?.getAttribute('aria-describedby')?.split(' ')).toContain(regionId);
    for (const input of inputs) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(regionId);
    }
    await mounted.unmount();
  });

  it('does the same for the billing schedule when the total is off', async () => {
    const mounted = await mount([schedule]);
    const group = mounted.container.querySelector('[role="group"]');
    const region = group?.querySelector('[role="alert"]');
    expect(region).not.toBeNull();
    expect(region?.textContent).toBe('');

    const percents = boxesLabelled(mounted.container, 'Percent');
    expect(percents).toHaveLength(2);
    await fill(percents[1] ?? null, '20');
    await submit(mounted.container);

    expect(region?.textContent).not.toBe('');
    const regionId = region?.getAttribute('id') ?? '';
    for (const input of percents) {
      expect(input.getAttribute('aria-invalid')).toBe('true');
      expect(input.getAttribute('aria-describedby')?.split(' ')).toContain(regionId);
    }
    await mounted.unmount();
  });

  it('clears the invalid marks once the field is edited', async () => {
    const mounted = await mount([sla], 'workflows');
    const inputs = boxesLabelled(mounted.container, ...HOURS);
    expect(inputs).toHaveLength(2);
    await fill(inputs[0] ?? null, '');
    await submit(mounted.container);
    await fill(inputs[0] ?? null, '12');
    const region = mounted.container.querySelector('[role="group"] [role="alert"]');
    expect(region?.textContent).toBe('');
    expect(inputs[0]?.getAttribute('aria-invalid')).toBeNull();
    await mounted.unmount();
  });
});
