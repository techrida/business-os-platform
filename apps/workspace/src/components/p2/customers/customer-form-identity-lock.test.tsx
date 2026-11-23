// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { CustomerForm } from './customer-form';
import { EMPTY_CUSTOMER_VALUES } from './forms';

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  Element.prototype.scrollIntoView = () => {};
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const form = (lockIdentity: boolean) => (
  <CustomerForm
    action={(prev) => Promise.resolve(prev)}
    initial={{
      ...EMPTY_CUSTOMER_VALUES,
      legalName: 'Acme Pvt. Ltd.',
      country: 'NP',
      panVatNo: '123456789',
    }}
    enabledCurrencies={['NPR']}
    mode="edit"
    customerId="11111111-1111-4111-8111-111111111111"
    version={2}
    cancelHref="/customers/1"
    reloadHref="/customers/1/edit"
    lockIdentity={lockIdentity}
  />
);

it('locks the legal name, PAN and country of a verified customer, and says why in the hints', async () => {
  mounted = await mountForm(form(true));
  const { container } = mounted;
  expect(container.querySelector<HTMLInputElement>('input[name="legalName"]')!.readOnly).toBe(true);
  const panField = [...container.querySelectorAll('label')]
    .find((l) => l.textContent?.includes('PAN or VAT number'))!
    .closest('[class*="field"]')!;
  const panBoxes = [...panField.querySelectorAll<HTMLInputElement>('input:not([type="hidden"])')];
  expect(panBoxes.length).toBeGreaterThan(0);
  expect(panBoxes.every((box) => box.readOnly)).toBe(true);
  expect(
    container
      .querySelector('input[type="hidden"][name="address.country"]')!
      .parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!.disabled,
  ).toBe(true);
  const text = container.textContent ?? '';
  expect(text).toContain('legal name of a verified customer cannot be edited');
  expect(text).toContain('PAN of a verified customer cannot be edited');
  expect(text).toContain('country of a verified customer cannot be edited');
});

it('leaves the identity fields open for a customer that is not verified', async () => {
  mounted = await mountForm(form(false));
  const { container } = mounted;
  expect(container.querySelector<HTMLInputElement>('input[name="legalName"]')!.readOnly).toBe(
    false,
  );
  expect(container.textContent ?? '').not.toContain('of a verified customer cannot be edited');
});
