// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm, settle, submit } from '@/test/form-interactions';

import type { InvoiceFormState } from './form-state';
import {
  type CustomerOption,
  type CustomerSearcher,
  ManualInvoiceForm,
} from './manual-invoice-form';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
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
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.unstubAllGlobals();
  document.body.innerHTML = '';
});

const CUSTOMERS = [
  {
    id: '11111111-1111-4111-8111-111111111111',
    label: 'Invoice customer',
    currency: 'NPR' as const,
  },
];

async function mount(
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState> = vi.fn(),
  customers: readonly CustomerOption[] = CUSTOMERS,
  extra: { customersCutOff?: boolean; search?: CustomerSearcher } = {},
) {
  mounted = await mountForm(
    <ManualInvoiceForm
      action={action}
      customers={customers}
      taxCodes={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
      {...extra}
    />,
  );
  const { container } = mounted;
  /** The visible box `Field` labels with `label`. */
  const box = (label: string): HTMLInputElement => {
    const id = Array.from(container.querySelectorAll('label[for]'))
      .find((l) => l.textContent?.trim().startsWith(label))
      ?.getAttribute('for');
    const input = id ? container.querySelector(`input[id="${id}"]`) : null;
    if (!(input instanceof HTMLInputElement)) throw new Error(`No box labelled ${label}`);
    return input;
  };
  const form = () => new FormData(container.querySelector('form')!);
  /** Every posted field whose name mentions the discount, with how often it is posted. */
  const discountFields = () =>
    [...form().keys()].filter((k) => k.toLowerCase().includes('discount')).sort();
  return { container, box, form, discountFields };
}

async function blur(element: HTMLInputElement) {
  await act(() => Promise.resolve(element.focus()));
  await act(() => Promise.resolve(element.blur()));
}

// UIP-FORM-009: the organization is one search-as-you-type box showing what the search matched. The old form was a
// plain select, so there was no combobox to type in and no options to read.
describe('the organization picker', () => {
  const EVEREST = '22222222-2222-4222-8222-222222222222';
  const people: CustomerOption[] = [
    ...CUSTOMERS,
    {
      id: EVEREST,
      label: 'Everest Foods Pvt. Ltd.',
      detail: 'CUS-0007 · 301234567',
      currency: 'INR',
    },
  ];
  const options = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());

  it('lists matches while typing, with number and PAN, and posts the chosen id', async () => {
    const { container, box, form } = await mount(vi.fn(), people);
    const input = box('Organization legal name');
    expect(input.getAttribute('role')).toBe('combobox');
    expect(container.querySelector('select[name="customerId"]')).toBeNull();
    expect(
      Array.from(container.querySelectorAll('button')).map((b) => b.textContent?.trim()),
    ).not.toContain('Search');

    // By name, then by the PAN the option shows: no button pressed in between.
    await fill(input, 'everest');
    expect(options()).toEqual(['Everest Foods Pvt. Ltd.CUS-0007 · 301234567']);
    await fill(input, '3012');
    expect(options()).toEqual(['Everest Foods Pvt. Ltd.CUS-0007 · 301234567']);
    // A pick-existing field: nothing found says so and offers no Create row.
    await fill(input, 'zzz');
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain('No matching customer.');

    await fill(input, 'everest');
    await click(document.querySelector('[role="option"]'));
    expect(form().get('customerId')).toBe(EVEREST);
    expect(input.value).toBe('Everest Foods Pvt. Ltd.');
    // Their usual currency (INR) is switched off here, so it is not preselected: the select would blank.
    expect(form().get('currency')).toBe('NPR');
  });

  it('lists more than 20 customers as one flat list, with no "Unassigned" header', async () => {
    // Fails on the old picker: past 20 options the Combobox grouped them under "Unassigned".
    const many: CustomerOption[] = Array.from({ length: 25 }, (_, i) => ({
      id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`,
      label: `Customer ${String(i).padStart(2, '0')}`,
      currency: 'NPR' as const,
    }));
    const { box } = await mount(vi.fn(), many);
    await click(box('Organization legal name'));
    expect(document.querySelectorAll('[role="option"]')).toHaveLength(25);
    expect(document.body.textContent).not.toContain('Unassigned');
  });
});

// The page loads only the first customers. Past that, typing asks the server (`/invoices/new/customers`) and lists
// its answer as given; the old picker only filtered the loaded list and said "Add the customer first" for a customer
// that was merely not loaded.
describe('the organization picker on a cut-off customer list', () => {
  const FAR = '33333333-3333-4333-8333-333333333333';
  const far: CustomerOption = {
    id: FAR,
    label: 'Far Away Traders',
    detail: 'CUS-0457 · 609999999',
    currency: 'INR',
  };
  const options = () =>
    Array.from(document.querySelectorAll('[role="option"]')).map((o) => o.textContent?.trim());
  const wait = () => act(() => new Promise<void>((resolve) => setTimeout(resolve, 400)));

  it('asks the server while typing, lists its answer as given and posts the chosen id', async () => {
    // The text is a misspelling the page's own filter would not match: the server's fuzzy answer is shown as it is.
    const search = vi.fn<CustomerSearcher>(() => Promise.resolve([far]));
    const { box, form } = await mount(vi.fn(), CUSTOMERS, { customersCutOff: true, search });
    const input = box('Organization legal name');
    await fill(input, 'faraway tradrs');
    expect(search).not.toHaveBeenCalled();
    await wait();
    expect(search).toHaveBeenCalledWith('faraway tradrs', expect.any(AbortSignal));
    expect(options()).toEqual(['Far Away TradersCUS-0457 · 609999999']);
    await click(document.querySelector('[role="option"]'));
    expect(form().get('customerId')).toBe(FAR);
    expect(input.value).toContain('Far Away Traders');
    // The chosen customer's usual currency (INR) is switched off here, so the select keeps NPR.
    expect(form().get('currency')).toBe('NPR');
  });

  it('does not say "Add the customer first" while the list is cut and the server has not answered', async () => {
    const search = vi.fn<CustomerSearcher>(() => Promise.resolve([]));
    const { box } = await mount(vi.fn(), CUSTOMERS, { customersCutOff: true, search });
    const input = box('Organization legal name');
    // One letter is matched against the loaded list only: it cannot rule a customer out.
    await fill(input, 'z');
    expect(search).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain('Keep typing to search all customers.');
    expect(document.body.textContent).not.toContain('Add the customer first');
    // Once the server has answered for the text, nothing found is a real answer.
    await fill(input, 'zzz');
    expect(document.body.textContent).toContain('Searching…');
    await wait();
    expect(document.body.textContent).toContain('No matching customer. Add the customer first.');
  });

  it('says the search did not load, not that nothing matches, when the server search fails', async () => {
    const search = vi.fn<CustomerSearcher>(() =>
      Promise.reject(new Error('Customer search failed with 503')),
    );
    const { box } = await mount(vi.fn(), CUSTOMERS, { customersCutOff: true, search });
    await fill(box('Organization legal name'), 'far away');
    await wait();
    expect(options()).toEqual([]);
    expect(document.body.textContent).toContain('Search did not load. Try again.');
    expect(document.body.textContent).not.toContain('Add the customer first');
  });

  it('does not ask the server when the whole list is already here', async () => {
    const search = vi.fn<CustomerSearcher>(() => Promise.resolve([]));
    const { box } = await mount(vi.fn(), CUSTOMERS, { search });
    await fill(box('Organization legal name'), 'invoice');
    await wait();
    expect(search).not.toHaveBeenCalled();
    expect(options()).toEqual(['Invoice customer']);
  });
});

// UIP-FORM-008: Optional sits beside the label; the hint keeps only what the label cannot say.
describe('optional fields', () => {
  it('marks Due date and both discounts Optional in the label row and no hint starts "Optional."', async () => {
    const { container } = await mount();
    for (const label of ['Due date', 'Discount %', 'Discount amount (NPR)']) {
      const el = Array.from(container.querySelectorAll('label[for]')).find((l) =>
        l.textContent?.startsWith(label),
      );
      expect(el?.parentElement?.textContent).toBe(`${label}Optional`);
    }
    expect(container.textContent).not.toMatch(/Optional\./);
  });
});

// Each test fails on the old form: it had one discount box behind a type select, with no "Discount %" box next to
// an amount box, so `box('Discount %')` finds nothing and nothing was worked out from the subtotal.
describe('the discount percent and amount', () => {
  it('works out the amount from a typed percentage and posts the percentage', async () => {
    const { box, form, discountFields } = await mount();
    await fill(box('Unit price (NPR)'), '5000');
    await fill(box('Discount %'), '10');

    expect(box('Discount amount (NPR)').value).toBe('500.00');
    expect(form().get('discountMode')).toBe('pct');
    expect(Number(form().get('discountValue'))).toBe(10);
    expect(form().getAll('discountValue')).toHaveLength(1);
    expect(discountFields()).toEqual(['discountMode', 'discountValue']);
  });

  it('works out the percentage from a typed amount and posts the amount', async () => {
    const { box, form, discountFields } = await mount();
    await fill(box('Unit price (NPR)'), '5000');
    await fill(box('Discount amount (NPR)'), '250.00');

    expect(box('Discount %').value).toBe('5');
    expect(form().get('discountMode')).toBe('amount');
    expect(Number(form().get('discountValue'))).toBe(250);
    expect(form().getAll('discountValue')).toHaveLength(1);
    expect(discountFields()).toEqual(['discountMode', 'discountValue']);
  });

  it('moves only the worked-out side when the subtotal changes', async () => {
    const { box, form } = await mount();
    const price = box('Unit price (NPR)');
    await fill(price, '5000');
    await fill(box('Discount %'), '10');
    await fill(price, '6000');
    expect(box('Discount amount (NPR)').value).toBe('600.00');
    expect(form().get('discountMode')).toBe('pct');
    expect(Number(form().get('discountValue'))).toBe(10);

    await fill(box('Discount amount (NPR)'), '300');
    await fill(box('Quantity'), '2');
    expect(box('Discount %').value).toBe('2.5');
    expect(form().get('discountMode')).toBe('amount');
    expect(Number(form().get('discountValue'))).toBe(300);
  });

  it('clears both sides when either one is emptied, and then posts no discount', async () => {
    const { box, form, discountFields } = await mount();
    await fill(box('Unit price (NPR)'), '5000');
    const percent = box('Discount %');
    const amount = box('Discount amount (NPR)');

    await fill(percent, '10');
    await fill(percent, '');
    expect(amount.value).toBe('');
    expect(form().get('discountMode')).toBe('none');
    expect(discountFields()).toEqual(['discountMode']);

    await fill(percent, '10');
    await fill(amount, '');
    expect(percent.value).toBe('');
    expect(form().get('discountMode')).toBe('none');
    expect(discountFields()).toEqual(['discountMode']);
  });

  it('leaves the posted side alone when the worked-out box is visited without an edit', async () => {
    const { box, form } = await mount();
    await fill(box('Unit price (NPR)'), '5000');
    await fill(box('Discount %'), '10');
    await blur(box('Discount amount (NPR)'));
    expect(form().get('discountMode')).toBe('pct');
    expect(Number(form().get('discountValue'))).toBe(10);
  });

  it('sends one discount to the action and keeps both sides after a refused save', async () => {
    const sent: FormData[] = [];
    const action = vi.fn((_prev: InvoiceFormState, data: FormData) => {
      sent.push(data);
      return Promise.resolve<InvoiceFormState>({
        key: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        errors: { customerId: 'Choose the customer.' },
      });
    });
    const { box, form, container } = await mount(action);
    await fill(box('Unit price (NPR)'), '5000');
    await fill(box('Discount %'), '10');
    await submit(container);
    await settle();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.get('discountMode')).toBe('pct');
    expect(sent[0]!.getAll('discountValue').map(Number)).toEqual([10]);
    expect(box('Discount %').value).toBe('10');
    expect(box('Discount amount (NPR)').value).toBe('500.00');
    expect(form().get('discountMode')).toBe('pct');
    expect(form().getAll('discountValue').map(Number)).toEqual([10]);
  });

  it('flags an amount that comes to more than the subtotal', async () => {
    const { box, container } = await mount();
    const price = box('Unit price (NPR)');
    await fill(price, '5000');
    await fill(box('Discount amount (NPR)'), '4000');
    await fill(price, '3000');
    expect(container.textContent).toContain('Enter no more than the subtotal before tax');
    expect(box('Discount amount (NPR)').getAttribute('aria-invalid')).toBe('true');
    // No percentage over 100 is shown for it.
    expect(box('Discount %').value).toBe('');
  });
});
