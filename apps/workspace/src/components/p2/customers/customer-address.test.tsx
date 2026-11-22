// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { CustomerAddress } from './customer-address';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
});

it('shows the street, city and country name on one line', async () => {
  mounted = await mountForm(
    <CustomerAddress address={{ line: 'Durbar Marg 1', city: 'Kathmandu' }} country="NP" />,
  );
  expect(mounted.container.textContent).toBe('Durbar Marg 1, Kathmandu, Nepal');
});

it('names a foreign customer’s country', async () => {
  mounted = await mountForm(
    <CustomerAddress address={{ line: '1 Market St', city: 'San Francisco' }} country="US" />,
  );
  expect(mounted.container.textContent).toBe('1 Market St, San Francisco, United States');
});
