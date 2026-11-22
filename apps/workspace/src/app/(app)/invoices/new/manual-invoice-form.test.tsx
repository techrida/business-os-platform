// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fill, mountForm, settle, submit } from '@/test/form-interactions';

import type { InvoiceFormState } from './form-state';
import { ManualInvoiceForm } from './manual-invoice-form';

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

async function mount(
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState> = vi.fn(),
) {
  mounted = await mountForm(
    <ManualInvoiceForm
      action={action}
      customers={[
        { id: '11111111-1111-4111-8111-111111111111', label: 'Invoice customer', currency: 'NPR' },
      ]}
      taxCodes={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"
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
