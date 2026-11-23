// @vitest-environment jsdom
// UIP-FORM-009 on Record payment: the customer is one search-as-you-type combobox. Typing lists the customers whose
// name, number or PAN match, each with its number and PAN under the name; no Find box, no Search button, no second
// select. Choosing one posts its id in the customerId hidden input, as the select it replaced did. A list the page cut
// off asks the server while the person types. Real form and real Combobox; the record action and the search are fakes.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { act } from 'react';

import { click, fill, mountForm, settle, submit } from '@/test/form-interactions';

import type { RecordPaymentState } from './form-state';
import { type CustomerOption, PaymentForm } from './payment-form';

const mocks = vi.hoisted(() => ({
  action: vi.fn<(prev: RecordPaymentState, form: FormData) => Promise<RecordPaymentState>>(),
}));
vi.mock('./actions', () => ({ recordPaymentAction: mocks.action }));

const EVEREST = '33333333-3333-4333-8333-333333333333';
const RUPEE = '99999999-9999-4999-8999-999999999999';
const FAR = '12121212-1212-4212-8212-121212121212';
const CUSTOMERS: CustomerOption[] = [
  {
    id: EVEREST,
    name: 'Everest Foods',
    number: 'CUS-0001',
    panVatNo: '301234567',
    defaultCurrency: 'NPR',
  },
  { id: RUPEE, name: 'Rupee Co', number: 'CUS-0002', panVatNo: null, defaultCurrency: 'INR' },
];

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
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';
});

const mount = (props: Partial<Parameters<typeof PaymentForm>[0]> = {}) =>
  mountForm(
    <PaymentForm
      idempotencyKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      today="2026-11-21"
      customers={CUSTOMERS}
      enabledCurrencies={['NPR', 'INR']}
      initialCustomerId=""
      reloadHref="/payments/new"
      {...props}
    />,
  );

/** The customer box: the combobox the "Customer" label points at. */
function customerBox(root: HTMLElement) {
  const forId = Array.from(root.querySelectorAll('label[for]'))
    .find((l) => l.textContent?.trim() === 'Customer')
    ?.getAttribute('for');
  const box = root.querySelector<HTMLInputElement>(`input#${CSS.escape(forId ?? 'missing')}`);
  if (box === null) throw new Error('No customer box');
  return box;
}
const options = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
const option = (startsWith: string) =>
  Array.from(document.querySelectorAll('[role="option"]')).find((o) =>
    o.textContent?.startsWith(startsWith),
  ) ?? null;
const posted = (root: HTMLElement, name: string) =>
  root.querySelector<HTMLInputElement>(`input[type="hidden"][name="${name}"]`)?.value;

describe('the customer picker', () => {
  it('is one combobox: no Search button and no separate select, matching by name, number and PAN', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      const box = customerBox(root);
      expect(box.getAttribute('role')).toBe('combobox');
      expect(root.querySelector('select[name="customerId"]')).toBeNull();
      expect(
        Array.from(root.querySelectorAll('button')).map((b) => b.textContent?.trim()),
      ).not.toContain('Search');

      await fill(box, 'everest');
      // Each option names the customer and shows the number and PAN the search also matches.
      expect(options()).toEqual(['Everest FoodsCUS-0001 · 301234567']);

      await fill(box, '3012');
      expect(options()).toEqual(['Everest FoodsCUS-0001 · 301234567']);
      await fill(box, 'CUS-0002');
      expect(options()).toEqual(['Rupee CoCUS-0002']);
      await fill(box, 'zzz');
      expect(options()).toEqual([]);
      expect(document.body.textContent).toContain('No matching customer.');
    } finally {
      await mounted.unmount();
    }
  });

  it('posts the chosen customer id and starts the currency on their usual one', async () => {
    const mounted = await mount();
    try {
      const root = mounted.container;
      await fill(customerBox(root), 'rupee');
      await click(option('Rupee Co'));
      expect(posted(root, 'customerId')).toBe(RUPEE);
      expect(customerBox(root).value).toBe('Rupee Co');
      expect(posted(root, 'currency')).toBe('INR');
    } finally {
      await mounted.unmount();
    }
  });

  it('still needs a customer: recording with none goes to the action, which names the field, not to the review', async () => {
    mocks.action.mockResolvedValue({
      key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      fieldErrors: { customerId: 'Choose the customer.' },
    });
    const mounted = await mount();
    try {
      const root = mounted.container;
      const amountFor = Array.from(root.querySelectorAll('label[for]'))
        .find((l) => l.textContent?.trim().startsWith('Amount received'))
        ?.getAttribute('for');
      await fill(root.querySelector(`input#${CSS.escape(amountFor ?? 'missing')}`), '100');
      await submit(root);
      await settle();
      expect(mocks.action).toHaveBeenCalledTimes(1);
      expect(document.querySelector('[role="dialog"]')).toBeNull();
      expect(root.textContent).toContain('Choose the customer.');
      expect(customerBox(root).getAttribute('aria-invalid')).toBe('true');
    } finally {
      await mounted.unmount();
    }
  });

  it('asks the server while typing when the page cut the list off, and can choose what it found', async () => {
    const far: CustomerOption = {
      id: FAR,
      name: 'Far Away Traders',
      number: 'CUS-0457',
      panVatNo: '609999999',
      defaultCurrency: 'NPR',
    };
    const search = vi.fn((_text: string, _signal: AbortSignal) => Promise.resolve([far]));
    const mounted = await mount({ customersCutOff: true, search });
    try {
      const root = mounted.container;
      await fill(customerBox(root), 'far away');
      expect(search).not.toHaveBeenCalled();
      // The wait for typing to pause, then the answer.
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
      expect(search).toHaveBeenCalledWith('far away', expect.any(AbortSignal));
      expect(options()).toEqual(['Far Away TradersCUS-0457 · 609999999']);
      await click(option('Far Away'));
      expect(posted(root, 'customerId')).toBe(FAR);
    } finally {
      await mounted.unmount();
    }
  });

  it('lists more than 20 customers flat, with no Unassigned header', async () => {
    const many: CustomerOption[] = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      name: `Customer ${String.fromCharCode(65 + i)}`,
      number: `CUS-${String(i + 1).padStart(4, '0')}`,
      panVatNo: null,
      defaultCurrency: 'NPR',
    }));
    const mounted = await mount({ customers: many });
    try {
      await click(customerBox(mounted.container));
      expect(options()).toHaveLength(25);
      expect(document.body.textContent).not.toContain('Unassigned');
    } finally {
      await mounted.unmount();
    }
  });

  it('does not ask the server when the whole list is already here', async () => {
    const search = vi.fn((_text: string, _signal: AbortSignal) =>
      Promise.resolve<CustomerOption[]>([]),
    );
    const mounted = await mount({ search });
    try {
      await fill(customerBox(mounted.container), 'everest');
      await act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));
      expect(search).not.toHaveBeenCalled();
    } finally {
      await mounted.unmount();
    }
  });
});
