// @vitest-environment jsdom
import type { CompanyBankAccount, Currency } from '@bos/contracts';
import { NO_SPACES } from '@bos/locale';
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PaymentRequestItem } from '@/lib/api-payables';
import { choose, click, fill, mountForm, typeKeys } from '@/test/form-interactions';

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
// The first bill is in INR, which the company has switched off; a payment request may still be in it.
const items = [
  bill(1, VENDOR, 'INR'),
  bill(2, VENDOR, 'NPR'),
  bill(3, VENDOR, 'USD'),
  bill(4, OTHER, 'INR'),
];

let mounted: Awaited<ReturnType<typeof mountForm>>;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(async () => {
  await mounted?.unmount();
  document.body.innerHTML = '';
});

const currencyField = () =>
  mounted.container.querySelector<HTMLInputElement>('input[type="hidden"][name="currency"]')!;
async function currencyOptions() {
  await click(currencyField().parentElement!.querySelector('button'));
  return Array.from(document.querySelectorAll('[role="option"]')).map((el) =>
    el.textContent?.trim(),
  );
}

it('offers every vendor bill currency, NPR first, including one switched off in Settings (D56 U16-Q1)', async () => {
  mounted = await mountForm(<PaymentRequestEntry idempotencyKey="key" items={items} />);
  await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
  expect(currencyField().value).toBe('NPR');
  expect(mounted.container.textContent).not.toContain('switched off');
  // Old code offered "INR, switched off" as a disabled option.
  expect(await currencyOptions()).toEqual(['NPR', 'INR', 'USD']);
  const inr = Array.from(document.querySelectorAll('[role="option"]')).find(
    (el) => el.textContent?.trim() === 'INR',
  );
  expect(inr?.getAttribute('aria-disabled')).not.toBe('true');
  await click(inr!);
  expect(currencyField().value).toBe('INR');
  expect(new FormData(mounted.container.querySelector('form')!).get('currency')).toBe('INR');
});

it('starts on the switched-off currency when it is the only one the vendor bills are in', async () => {
  mounted = await mountForm(<PaymentRequestEntry idempotencyKey="key" items={items} />);
  await choose(mounted.container, 'vendorPartyId', 'Terai Traders');
  // Old code left the currency empty, so nothing could be requested.
  expect(currencyField().value).toBe('INR');
  expect(mounted.container.textContent).not.toContain('switched off');
});

describe('the amount per bill', () => {
  const amountBox = () =>
    mounted.container
      .querySelector('input[type="hidden"][name="allocation:0:amount"]')!
      .parentElement!.querySelector<HTMLInputElement>('input[type="text"]')!;

  it('groups the amount as it is typed and posts the plain digits', async () => {
    mounted = await mountForm(<PaymentRequestEntry idempotencyKey="key" items={items} />);
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    const box = amountBox();
    // The visible box is named by its label; the hidden input carries the posted name.
    expect(box.getAttribute('name')).toBeNull();
    expect(document.querySelector(`label[for="${box.id}"]`)?.textContent).toBe('Amount 1');
    await fill(box, '1250000');
    // Old code showed the bare digits in a plain text input.
    expect(box.value).toBe('12,50,000');
    expect(new FormData(mounted.container.querySelector('form')!).get('allocation:0:amount')).toBe(
      '1250000',
    );
  });

  it('refuses a space inside the amount and says to remove it', async () => {
    mounted = await mountForm(<PaymentRequestEntry idempotencyKey="key" items={items} />);
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    const box = amountBox();
    await typeKeys(box, '10 ');
    // Old code took the space as typed and said nothing.
    expect(box.value).toBe('10');
    expect(mounted.container.textContent).toContain(NO_SPACES);
    await typeKeys(box, '50');
    expect(box.value).toBe('1,050');
    expect(new FormData(mounted.container.querySelector('form')!).get('allocation:0:amount')).toBe(
      '1050',
    );
  });
});

const account = (
  n: number,
  bankName: string,
  last4: string,
  currency: Currency,
  status: CompanyBankAccount['status'] = 'active',
): CompanyBankAccount => ({
  id: `5555555${n}-5555-4555-8555-555555555555`,
  name: `Account ${n}`,
  bankName,
  last4,
  currency,
  status,
  retiredAt: status === 'retired' ? '2026-11-01T00:00:00Z' : null,
});
const NABIL_NPR = account(1, 'Nabil Bank', '1234', 'NPR');
const GLOBAL_NPR = account(2, 'Global IME Bank', '5678', 'NPR');
const NABIL_USD = account(3, 'Nabil Bank', '9012', 'USD');
const RETIRED_NPR = account(4, 'Himalayan Bank', '0001', 'NPR', 'retired');
const accounts = [NABIL_NPR, GLOBAL_NPR, NABIL_USD, RETIRED_NPR];

const bankField = () =>
  mounted.container.querySelector<HTMLInputElement>(
    'input[type="hidden"][name="fromBankAccountId"]',
  )!;
const bankInput = () =>
  bankField().parentElement!.querySelector<HTMLInputElement>('input[role="combobox"]')!;
const shownOptions = () =>
  Array.from(document.querySelectorAll('[role="option"]')).map((el) => el.textContent?.trim());
async function key(target: Element, name: string) {
  await act(() => {
    target.dispatchEvent(
      new KeyboardEvent('keydown', { key: name, bubbles: true, cancelable: true }),
    );
    return Promise.resolve();
  });
}
const entry = (extra: { bankAccountsHref?: string } = {}) => (
  <PaymentRequestEntry idempotencyKey="key" items={items} bankAccounts={accounts} {...extra} />
);

describe('the pay-from bank account picker', () => {
  it('is a labelled combobox offering only active accounts in the request currency', async () => {
    mounted = await mountForm(entry());
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    const input = bankInput();
    // Named by its visible label, not a typed id (old code: "Paying entity bank account ID").
    const labelId = input.getAttribute('aria-labelledby');
    expect(labelId && document.getElementById(labelId)?.textContent).toBe('Pay from bank account');
    expect(mounted.container.textContent).not.toContain('bank account ID');
    input.focus();
    await key(input, 'ArrowDown');
    expect(shownOptions()).toEqual([
      'Account 1 · Nabil Bank ····1234 · NPR',
      'Account 2 · Global IME Bank ····5678 · NPR',
    ]);
  });

  it('filters by bank name and last four, and submits the chosen id from the keyboard', async () => {
    mounted = await mountForm(entry());
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    const input = bankInput();
    input.focus();
    await fill(input, 'nabil');
    expect(shownOptions()).toEqual(['Account 1 · Nabil Bank ····1234 · NPR']);
    await fill(input, '5678');
    expect(shownOptions()).toEqual(['Account 2 · Global IME Bank ····5678 · NPR']);
    await key(input, 'Enter');
    expect(bankField().value).toBe(GLOBAL_NPR.id);
    const form = mounted.container.querySelector('form')!;
    expect(new FormData(form).get('fromBankAccountId')).toBe(GLOBAL_NPR.id);
  });

  it('clears the chosen account when the currency changes to one it does not hold', async () => {
    mounted = await mountForm(entry());
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    const input = bankInput();
    input.focus();
    await fill(input, '1234');
    await key(input, 'Enter');
    expect(bankField().value).toBe(NABIL_NPR.id);

    await choose(mounted.container, 'currency', 'USD');
    expect(bankField().value).toBe('');
    expect(bankInput().value).toBe('');
    bankInput().focus();
    await key(bankInput(), 'ArrowDown');
    expect(shownOptions()).toEqual(['Account 3 · Nabil Bank ····9012 · USD']);
  });

  it('says there is no account in the currency, with a Settings link only when given one', async () => {
    mounted = await mountForm(entry({ bankAccountsHref: '/settings/company-accounts' }));
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    expect(mounted.container.textContent).not.toContain('No active NPR bank account.');
    await choose(mounted.container, 'currency', 'USD');
    expect(mounted.container.textContent).not.toContain('No active USD bank account.');
    await mounted.unmount();

    mounted = await mountForm(
      <PaymentRequestEntry
        idempotencyKey="key"
        items={items}
        bankAccounts={[NABIL_USD, RETIRED_NPR]}
        bankAccountsHref="/settings/company-accounts"
      />,
    );
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    // Only a retired NPR account: nothing to offer.
    expect(mounted.container.textContent).toContain('No active NPR bank account.');
    const link = mounted.container.querySelector<HTMLAnchorElement>(
      'a[href="/settings/company-accounts"]',
    );
    expect(link?.textContent).toBe('Settings > Bank and expense accounts');
    await mounted.unmount();

    mounted = await mountForm(
      <PaymentRequestEntry idempotencyKey="key" items={items} bankAccounts={[NABIL_USD]} />,
    );
    await choose(mounted.container, 'vendorPartyId', 'Himal Supplies');
    expect(mounted.container.textContent).toContain(
      'No active NPR bank account. Ask an administrator to add one in Settings > Bank and expense accounts.',
    );
    expect(mounted.container.querySelector('a[href="/settings/company-accounts"]')).toBeNull();
  });
});
