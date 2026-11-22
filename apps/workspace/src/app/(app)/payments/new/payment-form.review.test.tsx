// @vitest-environment jsdom
// Record payment opens a review of the payment first; only Confirm there sends it. Driven through the real form,
// the shared Dialog and a stubbed record action, so what is submitted is what the person left in the fields.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { amountInWords, DEFAULT_NUMBER_SYSTEMS } from '@bos/locale';

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

/** Types an amount and a bank reference, the fields the review repeats back. */
async function fillIn(root: HTMLElement) {
  await fill(boxFor(root, 'Amount received'), '1250');
  await fill(root.querySelector('input[name="bankReference"]'), 'NIC 77812');
}

describe('payment form review step', () => {
  it('opens a review of payer, amount in figures and words, currency, date and reference, and sends nothing', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      await fillIn(root);
      await click(button(root, 'Record payment'));
      // Old code posted straight away: no dialog, and the action ran.
      expect(mocks.action).not.toHaveBeenCalled();
      const review = dialog();
      expect(review?.textContent).toContain('Check the payment before you record it');
      expect(review?.textContent).toContain('Everest Foods (CUST-0001)');
      expect(review?.textContent).toContain('NPR 1,250.00');
      const words = amountInWords('1250', 'NPR', DEFAULT_NUMBER_SYSTEMS.NPR);
      expect(words).toMatch(/thousand/i);
      expect(review?.textContent).toContain(words);
      expect(review?.textContent).toContain('NPR (Nepalese rupee)');
      expect(review?.textContent).toContain('21 Nov 2026');
      expect(review?.textContent).toContain('NIC 77812');
    } finally {
      await mounted.unmount();
    }
  });

  it('goes back to the same form with every value kept, on Back and on Escape, and focus on Record', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      await fillIn(root);
      const amountBox = boxFor(root, 'Amount received');
      const record = button(root, 'Record payment');

      await click(record);
      await click(button(dialog()!, 'Back'));
      await settle();
      expect(dialog()).toBeNull();
      // The very same inputs, not a remounted form, still holding what was typed.
      expect(boxFor(root, 'Amount received')).toBe(amountBox);
      expect(amountBox?.value).toBe('1,250');
      expect(Number(root.querySelector<HTMLInputElement>('input[name="amount"]')?.value)).toBe(
        1250,
      );
      expect(root.querySelector<HTMLInputElement>('input[name="bankReference"]')?.value).toBe(
        'NIC 77812',
      );
      expect(document.activeElement).toBe(record);

      await click(record);
      expect(dialog()).not.toBeNull();
      await act(() => {
        (document.activeElement ?? document.body).dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
        );
        return Promise.resolve();
      });
      await settle();
      expect(dialog()).toBeNull();
      expect(boxFor(root, 'Amount received')).toBe(amountBox);
      expect(amountBox?.value).toBe('1,250');
      expect(document.activeElement).toBe(record);
      expect(mocks.action).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });

  it('sends the form once on Confirm, with the same fields a direct submit sent, even on a double click', async () => {
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
      await fillIn(root);
      const before = [...new FormData(root.querySelector('form')!).entries()];
      await click(button(root, 'Record payment'));
      const confirm = button(dialog()!, 'Confirm')!;
      await act(() => {
        confirm.click();
        confirm.click();
        return Promise.resolve();
      });
      expect(mocks.action).toHaveBeenCalledTimes(1);
      const sent = mocks.action.mock.calls[0]![1];
      expect([...sent.entries()]).toEqual(before);
      expect(sent.get('idempotencyKey')).toBe(KEY);
      expect(sent.get('customerId')).toBe(CUSTOMER_ID);
      expect(sent.get('currency')).toBe('NPR');
      expect(Number(sent.get('amount'))).toBe(1250);
      expect(sent.get('bankReference')).toBe('NIC 77812');
      expect(sent.get('receivedOn')).toBe('2026-11-21');
      await act(async () => {
        finish({ key: KEY });
        await Promise.resolve();
      });
      expect(mocks.action).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
    }
  });

  it('opens the review, not the action, on a plain form submit such as Enter in a field', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      await fillIn(root);
      await submit(root);
      // Old code sent the form to the action on any submit.
      expect(dialog()?.textContent).toContain('Check the payment before you record it');
      expect(mocks.action).not.toHaveBeenCalled();
      // Record stays the form's submit button, so a browser presses it for Enter in a text field.
      const record = button(root, 'Record payment');
      expect(record?.getAttribute('type')).toBe('submit');
      expect(record?.getAttribute('form')).toBe(root.querySelector('form')?.id);
    } finally {
      await mounted.unmount();
    }
  });

  it('skips the review for a form with a missing field, so the action answers with its inline messages', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      await click(button(root, 'Record payment'));
      // A review of blank values would say nothing; the action's own messages are shown as before.
      expect(dialog()).toBeNull();
      expect(mocks.action).toHaveBeenCalledTimes(1);
    } finally {
      await mounted.unmount();
    }
  });
});
