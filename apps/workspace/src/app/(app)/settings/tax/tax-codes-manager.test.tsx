// @vitest-environment jsdom
import type { AdminTaxCode, TaxCodePeriod } from '@bos/contracts';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, typeKeys } from '@/test/form-interactions';

// F1-Q49: the VAT codes table sends a change with the version of the last period it showed, so a stale screen is
// refused rather than overwriting someone else's change, and offers no day before today.

const actions = vi.hoisted(() => ({
  addTaxCodeAction: vi.fn(),
  changeTaxCodeAction: vi.fn(),
  retireTaxCodeAction: vi.fn(),
}));
vi.mock('./actions', () => actions);
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { TaxCodesManager } = await import('./tax-codes-manager');

const TODAY = '2026-11-20';
const period = (over: Partial<TaxCodePeriod> = {}): TaxCodePeriod => ({
  id: '11111111-1111-4111-8111-111111111111',
  name: 'VAT 13%',
  rate: '13',
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2025-07-17',
  effectiveTo: null,
  version: 3,
  ...over,
});
const open = period();
const VAT13: AdminTaxCode = {
  code: 'VAT13',
  kind: 'vat',
  periods: [open],
  current: open,
  next: null,
  endsOn: null,
  latest: open,
};
const retiredPeriod = period({ id: '2', effectiveTo: '2026-01-01', name: 'Old VAT' });
const OLD: AdminTaxCode = {
  code: 'OLD',
  kind: 'vat',
  periods: [retiredPeriod],
  current: null,
  next: null,
  endsOn: '2026-01-01',
  latest: retiredPeriod,
};

const buttonByText = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ??
  null;

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('TaxCodesManager', () => {
  it('lists every code with its status and offers no change on a retired one', async () => {
    const mounted = await mountForm(<TaxCodesManager codes={[OLD, VAT13]} today={TODAY} />);
    const rows = Array.from(mounted.container.querySelectorAll('tbody tr'));
    expect(rows[0]?.textContent).toContain('Retired from 2026-01-01');
    expect(rows[0]?.querySelector('button')).toBeNull();
    expect(rows[1]?.textContent).toContain('In use');
    expect(rows[1]?.textContent).toContain('13%');
    await mounted.unmount();
  });

  it('sends a change from today with the version it showed', async () => {
    actions.changeTaxCodeAction.mockResolvedValue({ status: 'ok', message: 'VAT13 changes.' });
    const mounted = await mountForm(<TaxCodesManager codes={[VAT13]} today={TODAY} />);
    await click(buttonByText('Change VAT13'));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('Documents already issued keep the rate');
    expect(dialog?.querySelector('input[type="number"]')).toBeNull();
    const rate = dialog?.querySelector<HTMLInputElement>('input[role="spinbutton"]') ?? null;
    expect(rate?.value).toBe('13');
    await typeKeys(rate, '{Backspace}{Backspace}15');
    expect(rate?.value).toBe('15');
    await act(() => {
      dialog?.querySelector('form')?.requestSubmit();
      return Promise.resolve();
    });
    expect(actions.changeTaxCodeAction).toHaveBeenCalledWith('VAT13', {
      name: 'VAT 13%',
      rate: '15',
      creditable: true,
      effectiveFrom: TODAY,
      expectedPeriodId: open.id,
      expectedVersion: 3,
    });
    await mounted.unmount();
  });

  it('adds a code with a percent box that refuses a third decimal and more than 100', async () => {
    actions.addTaxCodeAction.mockResolvedValue({ status: 'ok', message: 'VAT5 added.' });
    const mounted = await mountForm(<TaxCodesManager codes={[VAT13]} today={TODAY} />);
    await click(buttonByText('Add tax code'));
    const dialog = document.querySelector<HTMLElement>('[role="dialog"]')!;
    expect(dialog.querySelector('input[type="number"]')).toBeNull();
    const rate = dialog.querySelector<HTMLInputElement>('input[role="spinbutton"]');
    expect(rate?.type).toBe('text');
    expect(rate?.getAttribute('aria-valuemax')).toBe('100');

    await typeKeys(rate, '1001');
    expect(rate?.value).toBe('100');
    await typeKeys(rate, '{Backspace}{Backspace}{Backspace}5.255');
    expect(rate?.value).toBe('5.25');

    const named = (text: string) => {
      const label = Array.from(dialog.querySelectorAll('label')).find(
        (l) => l.textContent?.trim() === text,
      );
      return label ? document.getElementById(label.htmlFor) : null;
    };
    await fill(named('Code'), 'vat5');
    await fill(named('Name'), 'VAT 5%');
    await act(() => {
      dialog.querySelector('form')?.requestSubmit();
      return Promise.resolve();
    });
    expect(actions.addTaxCodeAction).toHaveBeenCalledWith({
      code: 'VAT5',
      name: 'VAT 5%',
      kind: 'vat',
      rate: '5.25',
      creditable: true,
      effectiveFrom: TODAY,
    });
    await mounted.unmount();
  });

  it('keeps the dialog open with the refusal when the change is refused', async () => {
    actions.changeTaxCodeAction.mockResolvedValue({
      status: 'error',
      message: 'Someone else changed this tax code. Reload the page to see the latest version.',
    });
    const mounted = await mountForm(<TaxCodesManager codes={[VAT13]} today={TODAY} />);
    await click(buttonByText('Change VAT13'));
    await act(() => {
      document.querySelector<HTMLFormElement>('[role="dialog"] form')?.requestSubmit();
      return Promise.resolve();
    });
    const alert = document.querySelector('[role="dialog"] [role="alert"]');
    expect(alert?.textContent).toContain('Someone else changed this tax code');
    await mounted.unmount();
  });
});
