// @vitest-environment jsdom
import type { Currency } from '@bos/contracts';
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@/lib/session', () => ({ getSession: vi.fn() }));
vi.mock('next/navigation', () => ({ redirect: vi.fn(), notFound: vi.fn() }));
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }));

const { PaymentForm } = await import('./payment-form');

const KEY = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
const INVOICE = { id: '1f8fad5b-d9cb-469f-a165-70867728950e', number: 'INV-2083/84-00001' };

// Real React and the real portal Select, opened as a person would, without a browser.
let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

async function mount(defaultCurrency: Currency, enabledCurrencies: Currency[]) {
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
  it('offers only the enabled currencies', async () => {
    await mount('NPR', ['NPR', 'USD']);
    expect(await currencyChoices()).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'USD', disabled: false },
    ]);
    expect(submitted()).toBe('NPR');
  });

  it("keeps an invoice's switched-off currency visible but disabled, and starts on NPR", async () => {
    await mount('INR', ['NPR', 'USD']);
    expect(container.textContent).toContain(
      'This invoice is in INR, which is switched off for the company. Choose another currency.',
    );
    expect(submitted()).toBe('NPR');
    expect(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe('');
    expect(await currencyChoices()).toEqual([
      { code: 'NPR', disabled: false },
      { code: 'USD', disabled: false },
      { code: 'INR', disabled: true },
    ]);
  });

  it("starts on an invoice's enabled currency with its open amount", async () => {
    await mount('USD', ['NPR', 'USD']);
    expect(submitted()).toBe('USD');
    expect(container.querySelector<HTMLInputElement>('input[name="amount"]')!.value).toBe(
      '1000000.00',
    );
    expect(container.textContent).not.toContain('switched off');
  });
});
