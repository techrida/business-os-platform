// @vitest-environment jsdom
// While a confirmed payment is being recorded, the Record button stays focusable. A focused button that turns
// `disabled` drops focus to the page body, and the review dialog hands focus back to Record as it closes, so the
// person would be left nowhere. Record says it is unavailable with aria-disabled, and its handlers ignore presses.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, settle, submit } from '@/test/form-interactions';

import { CUSTOMER_ID } from '../_lib/fixtures';

import type { RecordPaymentState } from './form-state';
import { PaymentForm } from './payment-form';

const mocks = vi.hoisted(() => ({
  action: vi.fn<(prev: RecordPaymentState, form: FormData) => Promise<RecordPaymentState>>(),
}));
vi.mock('./actions', () => ({ recordPaymentAction: mocks.action }));

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const mount = () =>
  mountForm(
    <PaymentForm
      idempotencyKey={KEY}
      today="2026-11-21"
      customers={[
        { id: CUSTOMER_ID, name: 'Everest Foods', number: 'CUST-0001', defaultCurrency: 'NPR' },
      ]}
      enabledCurrencies={['NPR', 'USD']}
      initialCustomerId={CUSTOMER_ID}
      reloadHref="/payments/new"
    />,
  );

function boxFor(root: HTMLElement, label: string) {
  const forId = Array.from(root.querySelectorAll('label[for]'))
    .find((l) => l.textContent?.trim().startsWith(label))
    ?.getAttribute('for');
  return root.querySelector<HTMLInputElement>(`input#${CSS.escape(forId ?? 'missing')}`);
}

const button = (root: ParentNode, text: string) =>
  Array.from(root.querySelectorAll('button')).find((b) => b.textContent?.trim() === text) ?? null;
const dialog = () => document.querySelector<HTMLElement>('[role="dialog"]');

describe('payment form focus while recording', () => {
  it('keeps Record focusable after Confirm and ignores presses until the action answers', async () => {
    let finish: (state: RecordPaymentState) => void = () => {};
    mocks.action.mockImplementation(
      () =>
        new Promise<RecordPaymentState>((resolve) => {
          finish = resolve;
        }),
    );
    const mounted = await mount();
    try {
      const root = mounted.container;
      await fill(boxFor(root, 'Amount received'), '1250');
      await fill(root.querySelector('input[name="bankReference"]'), 'NIC 77812');
      // Captured before its label changes to "Recording".
      const record = button(root, 'Record payment')!;
      await click(record);
      await click(button(dialog()!, 'Confirm'));
      await settle();
      expect(mocks.action).toHaveBeenCalledTimes(1);
      expect(record.textContent?.trim()).toBe('Recording');

      // Old code set `disabled`, which takes focus away from the button the dialog returns it to.
      expect(record.disabled).toBe(false);
      expect(record.getAttribute('aria-disabled')).toBe('true');
      expect(record.getAttribute('aria-busy')).toBe('true');
      expect(document.activeElement).toBe(record);

      // Pressing Record or Enter in a field while it records neither posts again nor reopens the review.
      await click(record);
      await submit(root);
      await settle();
      expect(mocks.action).toHaveBeenCalledTimes(1);
      expect(dialog()).toBeNull();

      await act(async () => {
        finish({ key: KEY });
        await Promise.resolve();
      });
      expect(record.textContent?.trim()).toBe('Record payment');
      expect(record.getAttribute('aria-disabled')).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });
});
