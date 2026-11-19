// @vitest-environment jsdom
import type { Currency } from '@bos/contracts';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { RFQ_ID } from '@/components/vendor/rfq-fixtures';

import { IDEM } from '../../../../_upload/test-kit';

// The form imports its server action; nothing here submits, so the action is a stub.
vi.mock('../actions', () => ({ submitQuoteAction: vi.fn() }));
vi.mock('next/link', () => ({
  default: ({ href, children }: { href: string; children: ReactNode }) => (
    <a href={href}>{children}</a>
  ),
}));

const { QuoteForm } = await import('./quote-form');

let root: Root;
let container: HTMLDivElement;

beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(() => Promise.resolve(root.unmount()));
  document.body.innerHTML = '';
});

async function mount(currencies: readonly Currency[]) {
  await act(() =>
    Promise.resolve(
      root.render(
        <QuoteForm
          idempotencyKey={IDEM}
          rfqId={RFQ_ID}
          today="2026-11-20"
          currencies={currencies}
        />,
      ),
    ),
  );
}

const currencyField = () =>
  container.querySelector<HTMLInputElement>('input[type="hidden"][name="currency"]')!;

/** Opens the currency picker and reads its choices. */
async function openCurrencyOptions(): Promise<string[]> {
  const trigger = currencyField().parentElement!.querySelector<HTMLButtonElement>('button')!;
  await act(() => Promise.resolve(trigger.click()));
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).map(
    (o) => o.textContent?.trim() ?? '',
  );
}

it('offers only the enabled currencies and starts on the first', async () => {
  await mount(['NPR', 'USD']);
  expect(currencyField().value).toBe('NPR');
  expect(await openCurrencyOptions()).toEqual(['NPR', 'USD']);
});

it('offers every currency when all are enabled', async () => {
  await mount(['NPR', 'INR', 'USD']);
  expect(await openCurrencyOptions()).toEqual(['NPR', 'INR', 'USD']);
});
