// @vitest-environment jsdom
import type { AdminPaymentTerm } from '@bos/contracts';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

// F1-Q49: the Payment terms panel sends each edit with the version it showed, so a stale screen is refused rather
// than overwriting someone else's change, and never offers to change the days of an existing term.

const actions = vi.hoisted(() => ({
  addPaymentTermAction: vi.fn(),
  renamePaymentTermAction: vi.fn(),
  setPaymentTermRetiredAction: vi.fn(),
}));
vi.mock('./payment-term-actions', () => actions);
vi.mock('@/components/ui/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
vi.stubGlobal('ResizeObserver', NoopResizeObserver);

const { PaymentTermsPanel, dueText } = await import('./payment-terms-panel');

const NET30: AdminPaymentTerm = {
  id: '22222222-2222-4222-8222-222222222222',
  code: 'NET30',
  name: 'Net 30',
  netDays: 30,
  retired: false,
  version: 4,
};
const COD: AdminPaymentTerm = {
  id: '33333333-3333-4333-8333-333333333333',
  code: 'COD',
  name: 'Cash on delivery',
  netDays: 0,
  retired: true,
  version: 1,
};

const buttonByText = (text: string): HTMLButtonElement | null =>
  Array.from(document.querySelectorAll('button')).find(
    (b) => b.textContent?.replace(/\s+/g, ' ').trim() === text,
  ) ?? null;

const submitDialog = () =>
  act(() => {
    document.querySelector<HTMLFormElement>('[role="dialog"] form')?.requestSubmit();
    return Promise.resolve();
  });

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

describe('PaymentTermsPanel', () => {
  it('says when each term is due and marks a retired one, with Restore instead of Retire', async () => {
    expect(dueText(0)).toBe('Due on receipt');
    expect(dueText(1)).toBe('Due in 1 day');
    const mounted = await mountForm(<PaymentTermsPanel terms={[NET30, COD]} />);
    const rows = Array.from(mounted.container.querySelectorAll('li'));
    expect(rows[0]?.textContent).toContain('Due in 30 days');
    expect(rows[1]?.textContent).toContain('Due on receipt');
    expect(rows[1]?.textContent).toContain('Retired');
    expect(buttonByText('Restore Cash on delivery')).not.toBeNull();
    expect(buttonByText('Retire Net 30')).not.toBeNull();
    await mounted.unmount();
  });

  it('retires with the version it showed', async () => {
    actions.setPaymentTermRetiredAction.mockResolvedValue({ status: 'ok', message: 'Retired.' });
    const mounted = await mountForm(<PaymentTermsPanel terms={[NET30]} />);
    await click(buttonByText('Retire Net 30'));
    expect(actions.setPaymentTermRetiredAction).toHaveBeenCalledWith(NET30.id, true, 4);
    await mounted.unmount();
  });

  it('closes a rename that changes nothing without a call, and offers no days field', async () => {
    const mounted = await mountForm(<PaymentTermsPanel terms={[NET30]} />);
    await click(buttonByText('Rename Net 30'));
    const dialog = document.querySelector('[role="dialog"]');
    expect(dialog?.querySelectorAll('input')).toHaveLength(1);
    expect(dialog?.textContent).toContain('including quotations already sent');
    await submitDialog();
    expect(actions.renamePaymentTermAction).not.toHaveBeenCalled();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await mounted.unmount();
  });

  it('keeps the rename dialog open with the refusal when the term changed meanwhile', async () => {
    actions.renamePaymentTermAction.mockResolvedValue({
      status: 'error',
      message: 'Someone else changed this payment term. Reload the page to see the latest version.',
    });
    const mounted = await mountForm(<PaymentTermsPanel terms={[NET30]} />);
    await click(buttonByText('Rename Net 30'));
    await fill(document.querySelector('[role="dialog"] input'), 'Net 30 days');
    await submitDialog();
    expect(actions.renamePaymentTermAction).toHaveBeenCalledWith(NET30.id, 'Net 30 days', 4);
    expect(document.querySelector('[role="dialog"] [role="alert"]')?.textContent).toContain(
      'Someone else changed this payment term',
    );
    await mounted.unmount();
  });
});
