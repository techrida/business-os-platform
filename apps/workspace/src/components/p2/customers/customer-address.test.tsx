// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { mountForm } from '@/test/form-interactions';

import { CustomerAddress } from './customer-address';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.restoreAllMocks();
});

it('renders two identical lines without a duplicate React key', async () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mounted = await mountForm(
    <CustomerAddress address={{ line1: 'KTM', city: 'KTM', country: 'NP' }} />,
  );
  const lines = [...mounted.container.querySelectorAll('span > span')].map((s) => s.textContent);
  expect(lines).toEqual(['KTM', 'KTM', 'NP']);
  expect(JSON.stringify(error.mock.calls)).not.toMatch(/same key/i);
});
