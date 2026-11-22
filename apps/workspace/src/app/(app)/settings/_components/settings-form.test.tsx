// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SettingsSectionId } from '@/lib/settings-nav';
import { choose, click, fill, mountForm, submit, typeKeys } from '@/test/form-interactions';

import type { SaveSettingsPageResult, SettingChangePayload } from './actions';
import type { FieldSpec } from './setting-fields';

const saveSettingsPageAction = vi.hoisted(() =>
  vi.fn<
    (
      section: SettingsSectionId,
      changes: readonly SettingChangePayload[],
    ) => Promise<SaveSettingsPageResult>
  >(),
);
vi.mock('./actions', () => ({
  saveSettingsPageAction,
  saveCardAction: vi.fn(),
  resetSettingAction: vi.fn(),
}));
const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }));
vi.mock('@/components/ui/toast', () => ({ toast }));
const router = vi.hoisted(() => ({
  push: vi.fn<(href: string) => void>(),
  replace: vi.fn<(href: string) => void>(),
  refresh: vi.fn<() => void>(),
}));
vi.mock('next/navigation', () => ({ useRouter: () => router }));

// jsdom does not ship ResizeObserver; Radix Dialog's body overflow hook calls it.
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { SettingsForm } = await import('./settings-form');
const { SettingCard } = await import('./setting-card');

const validitySpec = (value = '15', version: number | null = 2): FieldSpec => ({
  key: 'quotation.validity_days',
  label: 'Quotation validity (days)',
  kind: 'integer',
  current: { kind: 'text', value },
  defaultValue: { kind: 'text', value: '15' },
  version,
  defaultText: '15',
  isDefault: value === '15',
  numberBounds: { min: 1, max: 365, step: '1' },
});

const evidenceSpec = (value = 'signed_quote', version: number | null = 1): FieldSpec => ({
  key: 'sales.evidence_policy',
  label: 'Evidence before an opportunity is won',
  kind: 'select',
  current: { kind: 'text', value },
  defaultValue: { kind: 'text', value: 'signed_quote' },
  version,
  defaultText: 'Signed quotation',
  isDefault: value === 'signed_quote',
  options: [
    { value: 'signed_quote', label: 'Signed quotation' },
    { value: 'contract', label: 'Contract' },
    { value: 'purchase_order', label: 'Purchase order' },
    { value: 'both', label: 'Contract and purchase order' },
  ],
});

const scheduleSpec = (): FieldSpec => ({
  key: 'sales.default_schedule',
  label: 'Default billing schedule',
  kind: 'schedule',
  current: {
    kind: 'schedule',
    rows: [
      { label: 'Advance 60%', percent: '60', trigger: 'advance' },
      { label: 'Milestone 20%', percent: '20', trigger: 'milestone' },
      { label: 'Final 20%', percent: '20', trigger: 'uat' },
    ],
  },
  defaultValue: {
    kind: 'schedule',
    rows: [
      { label: 'Advance 60%', percent: '60', trigger: 'advance' },
      { label: 'Milestone 20%', percent: '20', trigger: 'milestone' },
      { label: 'Final 20%', percent: '20', trigger: 'uat' },
    ],
  },
  version: 3,
  defaultText: 'Advance 60%, Milestone 20%, Final 20%',
  isDefault: true,
});

const slaSpec = (): FieldSpec => ({
  key: 'approvals.sla_defaults',
  label: 'Default timing',
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
});

const vatSpec = (): FieldSpec => ({
  key: 'tax.vat_rate',
  label: 'Default VAT rate',
  kind: 'percent',
  current: { kind: 'text', value: '13' },
  defaultValue: { kind: 'text', value: '13' },
  version: 2,
  defaultText: '13',
  isDefault: true,
  numberBounds: { min: 0, max: 100, step: '0.01' },
});

const buttonByText = (root: ParentNode, text: string): HTMLButtonElement | null =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;

/** The visible boxes the fields' `<label>`s name; a number box's hidden input beside it posts the value. */
const boxesLabelled = (root: HTMLElement, label: string): HTMLInputElement[] =>
  Array.from(root.querySelectorAll('label'))
    .filter((tag) => tag.textContent === label)
    .map((tag) => root.ownerDocument.getElementById(tag.htmlFor))
    .filter(
      (box): box is HTMLInputElement => box instanceof HTMLInputElement && box.type === 'text',
    );
const boxLabelled = (root: HTMLElement, label: string): HTMLInputElement | null =>
  boxesLabelled(root, label)[0] ?? null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  saveSettingsPageAction.mockReset();
  toast.success.mockReset();
  toast.error.mockReset();
  router.push.mockReset();
  router.replace.mockReset();
  router.refresh.mockReset();
  window.history.replaceState(null, '', '/settings/sales');
});

describe('SettingsForm typed fields', () => {
  it('edits SLA fields as typed controls (hours + role select) with no JSON hidden inputs', async () => {
    saveSettingsPageAction.mockResolvedValue({
      status: 'ok',
      message: 'Changes saved.',
      saved: [
        {
          key: 'approvals.sla_defaults',
          value: {
            kind: 'sla',
            value: {
              remindAfterHours: '12',
              escalateAfterHours: '48',
              escalateToRole: 'management',
            },
          },
          version: 2,
        },
      ],
      fieldErrors: {},
      staleKeys: [],
    });

    const spec = slaSpec();
    const mounted = await mountForm(
      <SettingsForm section="workflows" fields={[spec]}>
        <SettingCard title="Timing" fields={[spec]} />
      </SettingsForm>,
    );

    // No raw JSON in any hidden input.
    const hiddenInputs = Array.from(mounted.container.querySelectorAll('input[type="hidden"]'));
    for (const h of hiddenInputs) {
      expect(h.getAttribute('value') ?? '').not.toContain('remindAfterHours');
    }

    const numInputs = [
      ...boxesLabelled(mounted.container, 'Remind after (hours)'),
      ...boxesLabelled(mounted.container, 'Escalate after (hours)'),
    ];
    expect(numInputs).toHaveLength(2);
    await fill(numInputs[0] ?? null, '12');
    await fill(numInputs[1] ?? null, '48');
    await choose(mounted.container, 'v:approvals.sla_defaults:role', 'Management');

    await submit(mounted.container);

    expect(saveSettingsPageAction).toHaveBeenCalledExactlyOnceWith('workflows', [
      {
        key: 'approvals.sla_defaults',
        value: {
          kind: 'sla',
          value: { remindAfterHours: '12', escalateAfterHours: '48', escalateToRole: 'management' },
        },
        expectedVersion: 1,
      },
    ]);
    await mounted.unmount();
  });

  it('posts a percent setting as a plain value from the shared percent input, with no number input left', async () => {
    saveSettingsPageAction.mockResolvedValue({
      status: 'ok',
      message: 'Changes saved.',
      saved: [{ key: 'tax.vat_rate', value: { kind: 'text', value: '12.51' }, version: 3 }],
      fieldErrors: {},
      staleKeys: [],
    });
    const spec = vatSpec();
    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[spec]}>
        <SettingCard title="Tax" fields={[spec]} />
      </SettingsForm>,
    );
    expect(mounted.container.querySelector('input[type="number"]')).toBeNull();
    const box = boxLabelled(mounted.container, 'Default VAT rate');
    const hidden = mounted.container.querySelector<HTMLInputElement>(
      'input[type="hidden"][name="v:tax.vat_rate"]',
    );
    expect(box?.hasAttribute('name')).toBe(false);
    expect(hidden?.value).toBe('13');

    // The contract's 0 to 100 and two-decimal step hold while typing: past max and a third decimal are refused.
    await fill(box, '101');
    expect(box?.value).toBe('13');
    await fill(box, '12.5');
    await typeKeys(box, '19');
    expect(box?.value).toBe('12.51');
    expect(hidden?.value).toBe('12.51');
    expect(new FormData(mounted.container.querySelector('form')!).get('v:tax.vat_rate')).toBe(
      '12.51',
    );

    await submit(mounted.container);
    expect(saveSettingsPageAction).toHaveBeenCalledExactlyOnceWith('sales', [
      { key: 'tax.vat_rate', value: { kind: 'text', value: '12.51' }, expectedVersion: 2 },
    ]);
    await mounted.unmount();
  });

  it('keeps four decimals in a schedule percent, as the contract allows', async () => {
    const spec = scheduleSpec();
    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[spec]}>
        <SettingCard title="Billing schedule" fields={[spec]} />
      </SettingsForm>,
    );
    const first = boxesLabelled(mounted.container, 'Percent')[0] ?? null;
    await fill(first, '33.3333');
    expect(first?.value).toBe('33.3333');
    await mounted.unmount();
  });

  it('edits schedule rows (add, remove, label, percent, trigger) and blocks save unless total = 100%', async () => {
    const spec = scheduleSpec();
    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[spec]}>
        <SettingCard title="Billing schedule" fields={[spec]} />
      </SettingsForm>,
    );

    // Remove the last row (20%) -> total drops to 80% -> shortfall "Add 20% more".
    const removeButtons = Array.from(mounted.container.querySelectorAll('button')).filter((b) =>
      b.textContent?.includes('Remove'),
    );
    expect(removeButtons).toHaveLength(3);
    await click(removeButtons[2] ?? null);

    expect(mounted.container.textContent).toContain('Total 80% of 100%');
    expect(mounted.container.textContent).toContain('Add 20% more');

    // Attempt to save while short: blocked client-side, toast + inline error, API not called.
    await submit(mounted.container);
    expect(saveSettingsPageAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Add 20% more'),
      expect.anything(),
    );
    expect(mounted.container.textContent).toContain(
      'Percentages must add up to 100%. Add 20% more.',
    );

    // Add a row with 25% -> total becomes 105% -> excess "Remove 5%".
    await click(buttonByText(mounted.container, 'Add row'));
    const textInputs = boxesLabelled(mounted.container, 'Label');
    const numInputs = boxesLabelled(mounted.container, 'Percent');
    expect(textInputs).toHaveLength(3);
    expect(numInputs).toHaveLength(3);
    await fill(textInputs[2] ?? null, 'Delivery 25%');
    await fill(numInputs[2] ?? null, '25');
    await choose(mounted.container, 'v:sales.default_schedule:trigger:2', 'On delivery');

    expect(mounted.container.textContent).toContain('Total 105% of 100%');
    expect(mounted.container.textContent).toContain('Remove 5%');

    toast.error.mockReset();
    await submit(mounted.container);
    expect(saveSettingsPageAction).not.toHaveBeenCalled();
    expect(toast.error).toHaveBeenCalledWith(
      expect.stringContaining('Remove 5%'),
      expect.anything(),
    );

    // Fix row 3 to 20% -> total reaches 100% -> save succeeds.
    await fill(numInputs[2] ?? null, '20');
    expect(mounted.container.textContent).toContain('Total 100% of 100%');

    saveSettingsPageAction.mockResolvedValue({
      status: 'ok',
      message: 'Changes saved.',
      saved: [
        {
          key: 'sales.default_schedule',
          value: {
            kind: 'schedule',
            rows: [
              { label: 'Advance 60%', percent: '60', trigger: 'advance' },
              { label: 'Milestone 20%', percent: '20', trigger: 'milestone' },
              { label: 'Delivery 25%', percent: '20', trigger: 'delivery' },
            ],
          },
          version: 4,
        },
      ],
      fieldErrors: {},
      staleKeys: [],
    });

    await submit(mounted.container);
    expect(saveSettingsPageAction).toHaveBeenCalledOnce();
    expect(toast.success).toHaveBeenCalledWith('Changes saved.', expect.anything());
    await mounted.unmount();
  });
});

describe('SettingsForm undo, multi-card save and partial failure', () => {
  it('shows Undo only when dirty and restores the saved value', async () => {
    const validity = validitySpec('20', 2);
    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[validity]}>
        <SettingCard title="Quotations" fields={[validity]} />
      </SettingsForm>,
    );

    // Clean initial render: Undo absent, Reset to default present (20 != 15).
    expect(
      mounted.container.querySelector(
        'button[aria-label="Undo change to Quotation validity (days)"]',
      ),
    ).toBeNull();
    expect(
      mounted.container.querySelector(
        'button[aria-label="Reset Quotation validity (days) to default"]',
      ),
    ).not.toBeNull();

    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '30');

    // Dirty: Undo button appears and Save is enabled.
    const undoBtn = mounted.container.querySelector(
      'button[aria-label="Undo change to Quotation validity (days)"]',
    );
    expect(undoBtn).not.toBeNull();
    expect(buttonByText(mounted.container, 'Save')?.disabled).toBe(false);

    // Clicking Undo restores saved '20', hides Undo, disables Save.
    await click(undoBtn);
    expect(input?.value).toBe('20');
    expect(
      mounted.container.querySelector(
        'button[aria-label="Undo change to Quotation validity (days)"]',
      ),
    ).toBeNull();
    expect(buttonByText(mounted.container, 'Save')?.disabled).toBe(true);

    await mounted.unmount();
  });

  it('sends only changed keys across cards and preserves unsaved fields across a partial failure', async () => {
    const validity = validitySpec('15', 2);
    const evidence = evidenceSpec('signed_quote', 1);
    const schedule = scheduleSpec();

    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[validity, evidence, schedule]}>
        <SettingCard title="Quotations" fields={[validity]} />
        <SettingCard title="Winning a deal" fields={[evidence]} />
        <SettingCard title="Billing schedule" fields={[schedule]} />
      </SettingsForm>,
    );

    const saveBtn = buttonByText(mounted.container, 'Save');
    expect(saveBtn?.disabled).toBe(true);

    // Change two cards (validity + evidence); leave schedule untouched.
    const validityInput = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(validityInput, '30');
    await choose(mounted.container, 'v:sales.evidence_policy', 'Contract');
    expect(saveBtn?.disabled).toBe(false);

    // Simulate mid-way partial failure: validity saved (v3), evidence failed.
    saveSettingsPageAction.mockResolvedValueOnce({
      status: 'partial',
      message:
        'Saved Quotation validity (days). Could not save Evidence before an opportunity is won.',
      saved: [
        {
          key: 'quotation.validity_days',
          value: { kind: 'text', value: '30' },
          version: 3,
        },
      ],
      fieldErrors: {
        'sales.evidence_policy': 'This was changed by someone else. Reload to see the latest.',
      },
      staleKeys: ['sales.evidence_policy'],
    });

    await submit(mounted.container);

    // Only the 2 changed keys were sent (schedule was NOT sent).
    expect(saveSettingsPageAction).toHaveBeenCalledTimes(1);
    expect(saveSettingsPageAction.mock.calls[0]?.[1].map((c) => c.key)).toEqual([
      'quotation.validity_days',
      'sales.evidence_policy',
    ]);

    // Saved key became the new baseline (no Undo button), while failed key stays dirty with inline error & banner.
    expect(
      mounted.container.querySelector(
        'button[aria-label="Undo change to Quotation validity (days)"]',
      ),
    ).toBeNull();
    expect(
      mounted.container.querySelector(
        'button[aria-label="Undo change to Evidence before an opportunity is won"]',
      ),
    ).not.toBeNull();
    expect(mounted.container.textContent).toContain(
      'Saved Quotation validity (days). Could not save Evidence before an opportunity is won.',
    );
    expect(mounted.container.textContent).toContain(
      'This was changed by someone else. Reload to see the latest.',
    );
    expect(toast.error).toHaveBeenCalledWith(
      'Saved Quotation validity (days). Could not save Evidence before an opportunity is won.',
      expect.anything(),
    );

    // Retrying Save sends ONLY the still-dirty evidence key (not the already-saved validity key).
    saveSettingsPageAction.mockResolvedValueOnce({
      status: 'ok',
      message: 'Changes saved.',
      saved: [
        {
          key: 'sales.evidence_policy',
          value: { kind: 'text', value: 'contract' },
          version: 2,
        },
      ],
      fieldErrors: {},
      staleKeys: [],
    });

    await submit(mounted.container);
    expect(saveSettingsPageAction).toHaveBeenCalledTimes(2);
    expect(saveSettingsPageAction.mock.calls[1]?.[1].map((c) => c.key)).toEqual([
      'sales.evidence_policy',
    ]);
    expect(buttonByText(mounted.container, 'Save')?.disabled).toBe(true);

    await mounted.unmount();
  });
});

describe('SettingsForm discard dialog rule', () => {
  it('discards a single changed setting silently without opening a confirmation dialog', async () => {
    const validity = validitySpec('15', 2);
    const evidence = evidenceSpec('signed_quote', 1);

    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[validity, evidence]}>
        <SettingCard title="Quotations" fields={[validity]} />
        <SettingCard title="Winning a deal" fields={[evidence]} />
      </SettingsForm>,
    );

    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '45');
    await click(buttonByText(mounted.container, 'Discard'));

    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(input?.value).toBe('15');
    expect(buttonByText(mounted.container, 'Save')?.disabled).toBe(true);

    await mounted.unmount();
  });

  it('opens a ConfirmDialog when discarding more than one changed setting', async () => {
    const validity = validitySpec('15', 2);
    const evidence = evidenceSpec('signed_quote', 1);

    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[validity, evidence]}>
        <SettingCard title="Quotations" fields={[validity]} />
        <SettingCard title="Winning a deal" fields={[evidence]} />
      </SettingsForm>,
    );

    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '45');
    await choose(mounted.container, 'v:sales.evidence_policy', 'Contract');

    await click(buttonByText(mounted.container, 'Discard'));

    // Dialog opens; keeping edits preserves values.
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain('Discard unsaved changes?');
    await click(buttonByText(dialog!, 'Keep editing'));
    expect(input?.value).toBe('45');

    // Open again and confirm discard.
    await click(buttonByText(mounted.container, 'Discard'));
    const dialog2 = document.querySelector('[role="dialog"]');
    expect(dialog2).not.toBeNull();
    await click(buttonByText(dialog2!, 'Discard changes'));
    expect(input?.value).toBe('15');
    expect(buttonByText(mounted.container, 'Save')?.disabled).toBe(true);

    await mounted.unmount();
  });
});

describe('SettingsForm stale protection', () => {
  it('keeps the version the person saw when the server value changes under an unsaved edit', async () => {
    saveSettingsPageAction.mockReset();
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    const render = (spec: FieldSpec) =>
      act(() =>
        Promise.resolve(
          root.render(
            <SettingsForm section="sales" fields={[spec]}>
              <SettingCard title="Quotations" fields={[spec]} />
            </SettingsForm>,
          ),
        ),
      );
    await render(validitySpec('15', 2));
    await fill(boxLabelled(container, 'Quotation validity (days)'), '90');
    // Someone else saved 30 (version 5) and the page refreshed: the edit stays, the version does not move.
    await render(validitySpec('30', 5));
    expect(boxLabelled(container, 'Quotation validity (days)')?.value).toBe('90');
    saveSettingsPageAction.mockResolvedValueOnce({
      status: 'ok',
      message: 'Changes saved.',
      saved: [{ key: 'quotation.validity_days', value: { kind: 'text', value: '90' }, version: 6 }],
    } as never);
    await click(buttonByText(container, 'Save'));
    expect(saveSettingsPageAction.mock.calls[0]?.[1]?.[0]?.expectedVersion).toBe(2);
    await act(() => Promise.resolve(root.unmount()));
    container.remove();
  });
});

describe('SettingsForm unsaved-leave guard', () => {
  it('does not open the leave dialog when Back only undoes an in-page hash jump', async () => {
    const validity = validitySpec('15', 2);
    const mounted = await mountForm(
      <SettingsForm section="sales" fields={[validity]}>
        <SettingCard title="Quotations" fields={[validity]} />
      </SettingsForm>,
    );
    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '90');
    window.history.replaceState(null, '', '#timing');
    await act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      return Promise.resolve();
    });
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    window.history.replaceState(null, '', window.location.pathname);
    await mounted.unmount();
  });

  it('blocks beforeunload, in-app link clicks, and popstate while dirty via ConfirmDialog', async () => {
    const validity = validitySpec('15', 2);

    const mounted = await mountForm(
      <div>
        <a href="/settings/purchasing">Go to purchasing</a>
        <SettingsForm section="sales" fields={[validity]}>
          <SettingCard title="Quotations" fields={[validity]} />
        </SettingsForm>
      </div>,
    );

    // Clean: beforeunload is NOT prevented.
    const cleanUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(cleanUnload);
    expect(cleanUnload.defaultPrevented).toBe(false);

    // Make dirty.
    const input = boxLabelled(mounted.container, 'Quotation validity (days)');
    await fill(input, '90');

    // Dirty: beforeunload IS prevented.
    const dirtyUnload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(dirtyUnload);
    expect(dirtyUnload.defaultPrevented).toBe(true);

    // Dirty: clicking an internal anchor opens ConfirmDialog instead of navigating immediately.
    const link = mounted.container.querySelector<HTMLAnchorElement>(
      'a[href="/settings/purchasing"]',
    );
    const clickEvent = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 });
    await act(() => {
      link?.dispatchEvent(clickEvent);
      return Promise.resolve();
    });
    expect(clickEvent.defaultPrevented).toBe(true);

    const linkDialog = document.querySelector('[role="dialog"]');
    expect(linkDialog?.textContent).toContain('Leave without saving?');
    await click(buttonByText(linkDialog!, 'Keep editing'));
    expect(router.push).not.toHaveBeenCalled();
    expect(router.replace).not.toHaveBeenCalled();
    expect(input?.value).toBe('90');

    // Clicking Back (popstate) while dirty opens ConfirmDialog; confirming calls history.go(-2).
    const goSpy = vi.spyOn(window.history, 'go').mockImplementation(() => {});
    // Back lands on the page's own entry, not on the sentinel.
    window.history.replaceState(null, '', window.location.pathname);
    await act(() => {
      window.dispatchEvent(new PopStateEvent('popstate'));
      return Promise.resolve();
    });
    const backDialog = document.querySelector('[role="dialog"]');
    expect(backDialog?.textContent).toContain('Leave without saving?');
    await click(buttonByText(backDialog!, 'Leave without saving'));
    expect(goSpy).toHaveBeenCalledWith(-2);
    goSpy.mockRestore();

    // Dirty again -> click link -> confirm leave navigates via router.
    await fill(input, '40');
    await act(() => {
      link?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, button: 0 }));
      return Promise.resolve();
    });
    const leaveDialog = document.querySelector('[role="dialog"]');
    expect(leaveDialog).not.toBeNull();
    await click(buttonByText(leaveDialog!, 'Leave without saving'));
    expect(router.replace.mock.calls.length + router.push.mock.calls.length).toBe(1);
    const navigatedTo = router.replace.mock.calls[0]?.[0] ?? router.push.mock.calls[0]?.[0];
    expect(navigatedTo).toBe('/settings/purchasing');

    await mounted.unmount();
  });
});
