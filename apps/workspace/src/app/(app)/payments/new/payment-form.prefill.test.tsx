// @vitest-environment jsdom
// U16-Q8 a: a form opened from an invoice starts on the invoice's currency and open amount, and that is only a
// starting value. Driven through the real form and a stubbed record action, so what is submitted is what the person
// left in the fields.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Currency } from '@bos/contracts';

import { click, fill, mountForm, submit } from '@/test/form-interactions';

import { CUSTOMER_ID } from '../_lib/fixtures';

import type { RecordPaymentState } from './form-state';
import { PaymentForm, type PaymentPrefill } from './payment-form';

const mocks = vi.hoisted(() => ({
  action: vi.fn<(prev: RecordPaymentState, form: FormData) => Promise<RecordPaymentState>>(),
}));
vi.mock('./actions', () => ({ recordPaymentAction: mocks.action }));

const KEY = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_ID = '99999999-9999-4999-8999-999999999999';

const PREFILL: PaymentPrefill = {
  customerId: CUSTOMER_ID,
  currency: 'USD',
  amount: '750.00',
  invoiceNumber: 'INV-2083/84-00001',
};

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

const mount = (
  prefill: PaymentPrefill | null = PREFILL,
  enabled: Currency[] = ['NPR', 'INR', 'USD'],
) =>
  mountForm(
    <PaymentForm
      idempotencyKey={KEY}
      today="2026-11-21"
      customers={[
        { id: CUSTOMER_ID, name: 'Everest Foods', number: 'CUST-0001', defaultCurrency: 'NPR' },
        { id: OTHER_ID, name: 'Rupee Co', number: 'CUST-0002', defaultCurrency: 'INR' },
      ]}
      enabledCurrencies={enabled}
      initialCustomerId={CUSTOMER_ID}
      prefill={prefill}
      reloadHref={`/payments/new?customerId=${CUSTOMER_ID}`}
    />,
  );

const value = (box: HTMLElement, name: string) =>
  box.querySelector<HTMLInputElement>(`input[name="${name}"]`)?.value;

/** The visible box of the field labelled `label`; the posted value is on a hidden input named after the field. */
function boxFor(box: HTMLElement, label: string) {
  const forId = Array.from(box.querySelectorAll('label[for]'))
    .find((l) => l.textContent?.trim().startsWith(label))
    ?.getAttribute('for');
  return box.querySelector<HTMLInputElement>(`input#${CSS.escape(forId ?? 'missing')}`);
}

/** Open the React Aria picker labelled `label` and choose the option whose text is `option`. */
async function pick(box: HTMLElement, label: string, option: string) {
  const forId = Array.from(box.querySelectorAll('label[for]'))
    .find((l) => l.textContent?.trim().startsWith(label))
    ?.getAttribute('for');
  expect(forId).toBeTruthy();
  await click(box.querySelector<HTMLButtonElement>(`button#${CSS.escape(forId!)}`));
  await click(
    Array.from(document.querySelectorAll('[role="option"]')).find(
      (o) => o.textContent?.trim() === option,
    ) ?? null,
  );
}

describe('payment form, opened from an invoice (U16-Q8 a)', () => {
  it('keeps the amount editable for a part payment and submits what the person left', async () => {
    mocks.action.mockResolvedValueOnce({ key: KEY });
    const mounted = await mount();
    try {
      const box = mounted.container;
      // Old code had no prefill: the amount started empty.
      expect(value(box, 'amount')).toBe('750.00');
      expect(value(box, 'currency')).toBe('USD');
      expect(box.textContent).toContain('The open amount of INV-2083/84-00001.');
      await fill(boxFor(box, 'Amount received'), '300.00');
      expect(value(box, 'amount')).toBe('300.00');
      // The hint no longer claims a typed amount is the open amount.
      expect(box.textContent).not.toContain('The open amount of');
      await submit(box);
      const sent = mocks.action.mock.calls[0]?.[1];
      expect(sent?.get('amount')).toBe('300.00');
      expect(sent?.get('currency')).toBe('USD');
      expect(sent?.get('customerId')).toBe(CUSTOMER_ID);
      // The submission is the ordinary one: the payment is allocated afterwards, not here.
      expect(sent?.has('invoiceId')).toBe(false);
    } finally {
      await mounted.unmount();
    }
  });

  it('drops an untouched open amount when another customer is chosen', async () => {
    const mounted = await mount();
    try {
      const box = mounted.container;
      const customerTrigger = box.querySelector<HTMLButtonElement>(
        `button#${CSS.escape(box.querySelector('label[for]')!.getAttribute('for')!)}`,
      );
      await click(customerTrigger);
      await click(
        Array.from(document.querySelectorAll('[role="option"]')).find(
          (o) => o.textContent?.trim() === 'Rupee Co (CUST-0002)',
        ) ?? null,
      );
      expect(value(box, 'customerId')).toBe(OTHER_ID);
      expect(value(box, 'amount')).toBe('');
      expect(value(box, 'currency')).toBe('INR');
      expect(box.textContent).not.toContain('The open amount of');
    } finally {
      await mounted.unmount();
    }
    // Opening React Aria pickers in jsdom takes a few seconds; room for a loaded full suite.
  }, 15_000);

  it('clears an untouched open amount once another currency is chosen, and never a typed one', async () => {
    const mounted = await mount();
    try {
      const box = mounted.container;
      expect(box.textContent).toContain('The open amount of INV-2083/84-00001.');
      await pick(box, 'Currency', 'INR (Indian rupee)');
      expect(value(box, 'currency')).toBe('INR');
      // 750.00 is a USD figure: the person enters what arrived in INR. Old code kept 750.00 and submitted it as INR.
      expect(value(box, 'amount')).toBe('');
      expect(box.textContent).not.toContain('The open amount of');
      expect(box.textContent).toContain('The cash that arrived');
      // A typed amount survives a currency change, even one equal to the open amount.
      await fill(boxFor(box, 'Amount received'), '750.00');
      await pick(box, 'Currency', 'NPR (Nepalese rupee)');
      expect(value(box, 'currency')).toBe('NPR');
      expect(value(box, 'amount')).toBe('750.00');
    } finally {
      await mounted.unmount();
    }
  }, 20_000);

  it('shows an NPR open amount grouped in lakhs and posts it plain', async () => {
    mocks.action.mockResolvedValueOnce({ key: KEY });
    const mounted = await mount({ ...PREFILL, currency: 'NPR', amount: '1250000.00' });
    try {
      const box = mounted.container;
      // Old code showed the API string as it came: 1250000.00.
      expect(boxFor(box, 'Amount received')?.value).toBe('12,50,000.00');
      expect(value(box, 'amount')).toBe('1250000.00');
      expect(box.textContent).toContain('The open amount of INV-2083/84-00001.');
      await submit(box);
      expect(mocks.action.mock.calls[0]?.[1].get('amount')).toBe('1250000.00');
    } finally {
      await mounted.unmount();
    }
  });

  it('groups typed amounts in the currency and posts the plain digits', async () => {
    mocks.action.mockResolvedValueOnce({ key: KEY });
    const mounted = await mount({ ...PREFILL, currency: 'NPR', amount: '1250000.00' });
    try {
      const box = mounted.container;
      await fill(boxFor(box, 'Amount received'), '1250000');
      await fill(boxFor(box, 'Tax withheld'), '2018180');
      // Old code left the text as typed: 1250000 and 2018180.
      expect(boxFor(box, 'Amount received')?.value).toBe('12,50,000');
      expect(boxFor(box, 'Tax withheld')?.value).toBe('20,18,180');
      await submit(box);
      const sent = mocks.action.mock.calls[0]?.[1];
      expect(sent?.get('amount')).toBe('1250000');
      expect(sent?.get('tdsWithheld')).toBe('2018180');
    } finally {
      await mounted.unmount();
    }
  });

  it('regroups a typed amount when the currency changes, and posts the same digits', async () => {
    mocks.action.mockResolvedValueOnce({ key: KEY });
    const mounted = await mount();
    try {
      const box = mounted.container;
      await fill(boxFor(box, 'Amount received'), '1250000');
      expect(boxFor(box, 'Amount received')?.value).toBe('1,250,000');
      // Leaving the box pads it to 2 decimals; the new currency's grouping follows.
      await pick(box, 'Currency', 'NPR (Nepalese rupee)');
      expect(boxFor(box, 'Amount received')?.value).toBe('12,50,000.00');
      await submit(box);
      expect(mocks.action.mock.calls[0]?.[1].get('amount')).toBe('1250000.00');
    } finally {
      await mounted.unmount();
    }
  }, 15_000);

  it('takes digits before a currency is chosen and groups them once one is', async () => {
    // The customer's usual NPR is switched off, so the form starts with no currency.
    const mounted = await mount(null, ['INR', 'USD']);
    try {
      const box = mounted.container;
      expect(value(box, 'currency')).toBe('');
      await fill(boxFor(box, 'Amount received'), '1250000');
      expect(boxFor(box, 'Amount received')?.value).toBe('1250000');
      expect(value(box, 'amount')).toBe('1250000');
      await pick(box, 'Currency', 'USD (US dollar)');
      expect(boxFor(box, 'Amount received')?.value).toBe('1,250,000.00');
      expect(value(box, 'amount')).toBe('1250000.00');
    } finally {
      await mounted.unmount();
    }
  }, 15_000);
});
