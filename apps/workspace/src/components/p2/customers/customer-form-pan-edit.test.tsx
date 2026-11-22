// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { fill, mountForm, submit, typeKeys } from '@/test/form-interactions';

import { CustomerForm } from './customer-form';
import { EMPTY_CUSTOMER_VALUES } from './forms';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
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
  const country = container.querySelector<HTMLInputElement>('input[name="country"]')!;

  await typeKeys(panBox(), '12345678');
  await fill(country, 'IN');
  await fill(country, 'NP');
  expect(panBox().value).toBe('12345678');

  await submit(container);
  // The PAN box's own capture listener cancelled the submit before this one saw it.
  expect(reached).toHaveBeenCalledWith(true);
  expect(document.activeElement).toBe(panBox());
});
