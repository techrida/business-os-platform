// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm, submit } from '@/test/form-interactions';

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

it('a save with nothing changed shows the neutral "Nothing changed" notice, not the red "Nothing was saved" (R6Q5)', async () => {
  mounted = await mountForm(
    <CustomerForm
      action={(prev) =>
        Promise.resolve({
          ...prev,
          notice: 'Nothing changed, so there is nothing to save.',
        })
      }
      initial={EMPTY_CUSTOMER_VALUES}
      enabledCurrencies={['NPR']}
      mode="edit"
      idempotencyKey="7c9e6679-7425-40de-944b-e07fc1f90ae7"
      customerId="11111111-1111-4111-8111-111111111111"
      version={1}
      cancelHref="/customers"
      reloadHref="/customers/x"
    />,
  );
  await submit(mounted.container);
  const text = mounted.container.textContent ?? '';
  expect(text).toContain('Nothing changed');
  expect(text).toContain('Nothing changed, so there is nothing to save.');
  expect(text).not.toContain('Nothing was saved');
  expect(mounted.container.querySelector('[role="alert"]')).toBeNull();
  expect(mounted.container.querySelector('[role="status"]')).not.toBeNull();
});
