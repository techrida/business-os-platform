// @vitest-environment jsdom
import type { Currency } from '@bos/contracts';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { PaymentRequestItem } from '@/lib/api-payables';
import { choose, click, mountForm } from '@/test/form-interactions';

vi.mock('next/navigation', () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock('./actions', () => ({
  createPaymentRequestAction: vi.fn(),
  submitPaymentRequestAction: vi.fn(),
  cancelPaymentRequestAction: vi.fn(),
}));

const { PaymentRequestEntry } = await import('./forms');

const VENDOR = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const bill = (n: number, vendorPartyId: string, currency: Currency): PaymentRequestItem => ({
  openItemId: `3333333${n}-3333-4333-8333-333333333333`,
  vendorPartyId,
  vendorName: vendorPartyId === VENDOR ? 'Himal Supplies' : 'Terai Traders',
  vendorBillId: `4444444${n}-4444-4444-8444-444444444444`,
  billNumber: `BILL-${n}`,
  vendorInvoiceNo: `INV-${n}`,
  currency,
  openAmount: '100.00',
  claimedAmount: '0.00',
  availableAmount: '100.00',
});
// The first bill is in INR, which the company has switched off.
const items = [
  bill(1, VENDOR, 'INR'),
  bill(2, VENDOR, 'NPR'),
  bill(3, VENDOR, 'USD'),
  bill(4, OTHER, 'INR'),
];

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
});
afterEach(async () => {
  await mounted?.unmount();
});

const currencyField = () =>
  mounted.container.querySelector<HTMLInputElement>('input[type="hidden"][name="currency"]')!;
async function currencyOptions() {
  await click(currencyField().parentElement!.querySelector('button'));
  return Array.from(document.querySelectorAll('[role="option"]')).map((el) =>
    el.textContent?.trim(),
  );
}

it('offers only the vendor bill currencies that are enabled, starting on an enabled one', async () => {
  mounted = await mountForm(
    <PaymentRequestEntry idempotencyKey="key" items={items} enabledCurrencies={['NPR', 'USD']} />,
  );
  await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
  expect(currencyField().value).toBe('NPR');
  expect(await currencyOptions()).toEqual(['NPR', 'USD']);
});

it('says why nothing is offered when the vendor bills are all in a switched-off currency', async () => {
  mounted = await mountForm(
    <PaymentRequestEntry idempotencyKey="key" items={items} enabledCurrencies={['NPR', 'USD']} />,
  );
  await choose(mounted.container, 'vendorPartyId', 'Terai Traders');
  expect(currencyField().value).toBe('');
  expect(mounted.container.textContent).toContain(
    "This vendor's approved bills are only in currencies switched off in Settings.",
  );
});
