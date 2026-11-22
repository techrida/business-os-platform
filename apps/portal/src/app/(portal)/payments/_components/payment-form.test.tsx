// @vitest-environment jsdom
import type { Currency } from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

import { boxOf, fill, paste, posted } from '@/test/number-entry';

const { PaymentForm } = await import('./payment-form');

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVOICE = { id: '1f8fad5b-d9cb-469f-a165-70867728950e', number: 'INV-2083/84-00001' };

// Real React and the real portal Select, opened as a person would, without a browser.
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount(
  defaultCurrency: Currency,
  enabledCurrencies: Currency[],
  numberSystems?: NumberSystems,
) {
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
  await act(() =>
    Promise.resolve(
      root.render(
        <PaymentForm
          idempotencyKey={KEY}
          today="2026-11-10"
          invoice={defaultCurrency === 'NPR' ? undefined : INVOICE}
          defaultCurrency={defaultCurrency}
          enabledCurrencies={enabledCurrencies}
          suggestedAmount={defaultCurrency === 'NPR' ? '' : '1000000.00'}
          numberSystems={numberSystems}
        />,
      ),
    ),
  );
}

/** Open the Currency picker and read its choices. */
async function currencyChoices() {
  const label = Array.from(container.querySelectorAll('label')).find(
    (l) => l.textContent === 'Currency',
  );
  const trigger = document.getElementById(label!.htmlFor);
  await act(() => Promise.resolve(trigger!.click()));
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map((o) => ({
    code: o.textContent?.trim(),
    disabled: o.getAttribute('aria-disabled') === 'true',
  }));
}

const submitted = () => new FormData(container.querySelector('form')!).get('currency');

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
});

afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  document.body.innerHTML = '';
});

describe('PaymentForm currency picker', () => {
  it('offers every currency, choosable, and names the switched-off ones', async () => {
    await mount('NPR', ['NPR', 'USD']);
    // Old code left INR out: a payment sent in INR could not be submitted.
    expect(await currencyChoices()).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'INR, switched off', disabled: false },
      { code: 'USD', disabled: false },
    ]);
    expect(submitted()).toBe('NPR');
  });

  it("starts blank on an invoice's switched-off currency, with the open amount filled in", async () => {
    await mount('INR', ['NPR', 'USD']);
    expect(container.textContent).toContain(
      'This invoice is in INR, which is switched off for the company. Payments in it are still accepted. The amount filled in is in INR.',
    );
    // Old code started on NPR and left the amount empty.
    expect(submitted()).toBe('');
    expect(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(
      '1000000.00',
    );
    expect(await currencyChoices()).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'INR, switched off', disabled: false },
      { code: 'USD', disabled: false },
    ]);
  });

  it("starts on an invoice's enabled currency with its open amount", async () => {
    await mount('USD', ['NPR', 'USD']);
    expect(submitted()).toBe('USD');
    expect(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(
      '1000000.00',
    );
    expect(container.textContent).not.toContain('Payments in it are still accepted');
  });
});

describe('PaymentForm amount boxes', () => {
  // Old code showed `1250000` in a plain text box and posted whatever was typed.
  it('groups the amount as it is typed, in the company number system, and posts it plain', async () => {
    await mount('NPR', ['NPR', 'USD']);
    const box = boxOf(container, 'Amount paid');
    await fill(box, '1250000');
    expect(box.value).toBe('12,50,000');
    expect(posted(container, 'amount')).toBe('1250000');
  });

  it('follows the numberSystems prop and the chosen currency', async () => {
    // USD defaults to international grouping; the setting says lakh.
    await mount('USD', ['NPR', 'USD'], {
      NPR: 'south_asian',
      INR: 'south_asian',
      USD: 'south_asian',
    });
    const box = boxOf(container, 'Amount paid');
    await fill(box, '1250000');
    expect(box.value).toBe('12,50,000');
  });

  it('groups USD in the international style by default', async () => {
    await mount('USD', ['NPR', 'USD']);
    const box = boxOf(container, 'Amount paid');
    await fill(box, '1250000');
    expect(box.value).toBe('1,250,000');
  });

  it('refuses a pasted `10 50` rather than posting 1050, and reads a pasted `Rs. 1,250/-`', async () => {
    await mount('NPR', ['NPR', 'USD']);
    const box = boxOf(container, 'Amount paid');
    await paste(box, '10 50');
    expect(box.value).toBe('');
    expect(posted(container, 'amount')).toBe('');
    await paste(box, 'Rs. 1,250/-');
    expect(box.value).toBe('1,250');
    expect(posted(container, 'amount')).toBe('1250');
  });

  it('groups the withheld tax the same way and keeps it optional', async () => {
    await mount('NPR', ['NPR', 'USD']);
    expect(posted(container, 'tdsWithheld')).toBe('');
    const box = boxOf(container, 'Tax withheld');
    await fill(box, '125000');
    expect(box.value).toBe('1,25,000');
    expect(posted(container, 'tdsWithheld')).toBe('125000');
  });

  it('on a blank currency still limits digits but shows no currency code', async () => {
    await mount('INR', ['NPR', 'USD']);
    const box = boxOf(container, 'Amount paid');
    // A MoneyInput would group the prefill as 10,00,000.00 and carry an INR prefix.
    expect(box.value).toBe('1000000.00');
    expect(box.parentElement?.textContent).not.toContain('INR');
    expect(posted(container, 'amount')).toBe('1000000.00');
    await fill(box, '12345678901234567');
    expect(box.value).not.toContain('12345678901234567');
  });
});
