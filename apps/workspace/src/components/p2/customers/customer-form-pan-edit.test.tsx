// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm, submit, typeKeys } from '@/test/form-interactions';

import { CustomerForm } from './customer-form';
import { EMPTY_CUSTOMER_VALUES } from './forms';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  // jsdom has no layout; the country list scrolls its highlighted option into view.
  Element.prototype.scrollIntoView = () => {};
});

/** The address's Country box (the searchable combobox beside its hidden `address.country`). */
const countryBox = (root: ParentNode) =>
  root
    .querySelector('input[type="hidden"][name="address.country"]')!
    .parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;

/** Picks the address country by searching for it and pressing Enter, as a person does. */
async function pickCountry(root: ParentNode, search: string) {
  const box = countryBox(root);
  await act(() => Promise.resolve(box.focus()));
  await act(() => Promise.resolve(box.select()));
  await typeKeys(box, search);
  await act(() =>
    Promise.resolve(
      box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })),
    ),
  );
}
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

it('still stops a short PAN after the country is switched away from Nepal and back', async () => {
  mounted = await mountForm(
    <CustomerForm
      action={(prev) => Promise.resolve(prev)}
      initial={EMPTY_CUSTOMER_VALUES}
      enabledCurrencies={['NPR']}
      mode="create"
      idempotencyKey="7c9e6679-7425-40de-944b-e07fc1f90ae7"
      customerId="11111111-1111-4111-8111-111111111111"
      version={1}
      cancelHref="/customers"
      reloadHref="/customers/new"
    />,
  );
  const { container } = mounted;
  const form = container.querySelector('form')!;
  const reached = vi.fn();
  form.addEventListener('submit', (event) => {
    reached(event.defaultPrevented);
    event.preventDefault();
  });
  const panBox = () =>
    container
      .querySelector('input[name="panVatNo"]')!
      .parentElement!.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;

  await typeKeys(panBox(), '12345678');
  await pickCountry(container, 'india');
  await pickCountry(container, 'nepal');
  expect(panBox().value).toBe('12345678');

  await submit(container);
  // The PAN box's own capture listener cancelled the submit before this one saw it.
  expect(reached).toHaveBeenCalledWith(true);
  expect(document.activeElement).toBe(panBox());
});

async function mountCustomer(initial: typeof EMPTY_CUSTOMER_VALUES) {
  mounted = await mountForm(
    <CustomerForm
      action={(prev) => Promise.resolve(prev)}
      initial={initial}
      enabledCurrencies={['NPR']}
      mode="edit"
      customerId="11111111-1111-4111-8111-111111111111"
      version={1}
      cancelHref="/customers"
      reloadHref="/customers/1/edit"
    />,
  );
  const { container } = mounted;
  const reached = vi.fn();
  container.querySelector('form')!.addEventListener('submit', (event) => {
    reached(event.defaultPrevented);
    event.preventDefault();
  });
  const panBox = () =>
    container
      .querySelector('input[name="panVatNo"]')!
      .parentElement!.querySelector<HTMLInputElement>('input:not([type="hidden"])')!;
  return { container, reached, panBox };
}

it('stops a short tax id typed under another country once the country becomes Nepal', async () => {
  const { container, reached, panBox } = await mountCustomer({
    ...EMPTY_CUSTOMER_VALUES,
    country: 'IN',
  });

  // Typed in the foreign tax-id box, not the PAN box.
  await typeKeys(panBox(), '12345');
  await pickCountry(container, 'nepal');
  expect(panBox().value).toBe('12345');

  await submit(container);
  expect(reached).toHaveBeenCalledWith(true);
  expect(panBox().getAttribute('aria-invalid')).toBe('true');
  expect(document.activeElement).toBe(panBox());
});

it('does not stop a stored short tax id nobody edited when the country becomes Nepal', async () => {
  const { container, reached, panBox } = await mountCustomer({
    ...EMPTY_CUSTOMER_VALUES,
    country: 'IN',
    panVatNo: '12345',
  });

  await pickCountry(container, 'nepal');
  expect(panBox().value).toBe('12345');

  await submit(container);
  expect(reached).toHaveBeenCalledWith(false);
  expect(panBox().getAttribute('aria-invalid')).toBeNull();
});

it("keeps the typed PAN when the country changes and switches to that country's rule", async () => {
  const { container, panBox } = await mountCustomer(EMPTY_CUSTOMER_VALUES);

  // Nepal: the nine-digit PAN box, which takes digits only.
  await typeKeys(panBox(), '3012A');
  expect(panBox().value).toBe('3012');
  expect(container.textContent).toContain('Optional. Nine digits.');

  // Abroad: the same text, in a box that also takes letters and hyphens.
  await pickCountry(container, 'united states');
  expect(panBox().value).toBe('3012');
  await typeKeys(panBox(), '-AB');
  expect(panBox().value).toBe('3012-AB');
  expect(container.textContent).toContain('Letters, digits and hyphens');
  expect(container.textContent).not.toContain('Nine digits.');
  expect(container.querySelector<HTMLInputElement>('input[name="panVatNo"]')!.value).toBe(
    '3012-AB',
  );
});
