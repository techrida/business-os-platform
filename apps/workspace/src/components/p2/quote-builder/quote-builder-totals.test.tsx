// @vitest-environment jsdom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, mountForm } from '@/test/form-interactions';

import { emptyValues, type BuilderValues } from './model';
import { PREVIEW_TIMEOUT_MS, QuoteBuilder, type BuilderTarget } from './quote-builder';
import type { PreviewResult } from './schemas';

// TR-Q8 (test run r3s1): after the first Save draft the totals said "Updating totals" for good. The
// edit page's script chunks had answered 502, so the page never hydrated and kept the words the server
// rendered. These tests drive the real builder: its server HTML, and its client with a reply that
// never comes.

const mocks = vi.hoisted(() => ({
  saveDraftAction: vi.fn(),
  previewQuoteAction: vi.fn(),
  submitQuoteAction: vi.fn(),
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('./actions', () => ({
  saveDraftAction: mocks.saveDraftAction,
  previewQuoteAction: mocks.previewQuoteAction,
  submitQuoteAction: mocks.submitQuoteAction,
}));
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }),
  unstable_rethrow: vi.fn(),
}));
vi.mock('@/components/ui/toast', () => ({
  toast: { success: mocks.success, error: mocks.error },
}));

const Q = '22222222-2222-4222-8222-222222222222';
const EDIT: BuilderTarget = {
  mode: 'edit',
  quotationId: Q,
  versionId: '33333333-3333-4333-8333-333333333333',
  expectedVersion: 4,
};
const TAX = '55555555-5555-4555-8555-555555555555';

const preview: PreviewResult = {
  totals: {
    subtotal: '120000.00',
    discountAmount: '0.00',
    taxableAmount: '120000.00',
    taxAmount: '15600.00',
    total: '135600.00',
    effectiveDiscountPct: '0',
  },
  taxSummary: [],
  route: { steps: [], blocked: false },
};

function initial(): BuilderValues {
  return {
    ...emptyValues({ currency: 'NPR', issueDate: '2026-11-19', validUntil: '2026-12-04' }),
    lines: [
      {
        key: 'l1',
        description: 'BOS Demo implementation service',
        uom: 'lot',
        quantity: '2',
        unitPrice: '60000.00',
        taxCodeId: TAX,
        unitCost: null,
        catalogItemId: null,
      },
    ],
  };
}

const builder = () => (
  <QuoteBuilder
    target={EDIT}
    title="QT-2082-0042 Rev 1"
    cancelHref={`/quotations/${Q}`}
    initial={initial()}
    context={null}
    contacts={[]}
    taxCodes={[]}
    paymentTerms={[]}
    enabledCurrencies={['NPR']}
    idempotencyKey="44444444-4444-4444-8444-444444444444"
  />
);

const totalsPanel = (root: ParentNode = document): string =>
  root.querySelector('aside')?.textContent ?? '';

let mounted: Awaited<ReturnType<typeof mountForm>> | undefined;
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
  for (const m of Object.values(mocks)) m.mockReset();
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  vi.useRealTimers();
  document.body.innerHTML = '';
});

describe('quotation totals before the page script runs (TR-Q8)', () => {
  it('the server HTML does not claim an update is on its way, and links a plain reload', () => {
    const html = renderToStaticMarkup(builder());
    expect(html).not.toContain('Updating totals');
    expect(html).not.toContain('Checking approval requirements');
    expect(html).toContain('The totals appear once the page has finished loading.');
    expect(html).toContain(`href="/quotations/${Q}/edit"`);
    expect(mocks.previewQuoteAction).not.toHaveBeenCalled();
  });
});

describe('quotation totals when the reply never comes (TR-Q8)', () => {
  it('turns into an error with Try again after the limit, and Try again prices the draft again', async () => {
    vi.useFakeTimers();
    mocks.previewQuoteAction.mockReturnValueOnce(new Promise(() => {}));
    mounted = await mountForm(builder());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.previewQuoteAction).toHaveBeenCalledTimes(1);
    expect(totalsPanel()).toContain('Updating totals');

    await act(async () => {
      await vi.advanceTimersByTimeAsync(PREVIEW_TIMEOUT_MS);
    });
    expect(totalsPanel()).not.toContain('Updating totals');
    expect(totalsPanel()).toContain('The totals did not load. Try again.');

    mocks.previewQuoteAction.mockResolvedValueOnce({ ok: true, preview });
    const retry = Array.from(document.querySelectorAll('aside button')).find(
      (b) => b.textContent?.trim() === 'Try again',
    );
    await click(retry ?? null);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.previewQuoteAction).toHaveBeenCalledTimes(2);
    expect(totalsPanel()).toContain('Grand total');
    expect(totalsPanel()).toContain('1,35,600.00');
  });

  it('offers Try again on a refused preview too, not only on a timeout', async () => {
    vi.useFakeTimers();
    mocks.previewQuoteAction.mockResolvedValueOnce({
      ok: false,
      kind: 'error',
      message:
        'The platform did not respond. The totals could not be worked out; try again in a moment.',
    });
    mounted = await mountForm(builder());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(totalsPanel()).toContain('The platform did not respond.');
    expect(
      Array.from(document.querySelectorAll('aside button')).some(
        (b) => b.textContent?.trim() === 'Try again',
      ),
    ).toBe(true);
  });
});
