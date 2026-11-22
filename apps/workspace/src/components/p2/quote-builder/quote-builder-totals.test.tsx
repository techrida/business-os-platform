// @vitest-environment jsdom
import { act } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { emptyValues, toContent, type BuilderValues } from './model';
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

/** The visible discount box named by its label. */
function discountBox(label: string): HTMLInputElement {
  const found = Array.from(document.querySelectorAll('label'))
    .filter((l) => l.textContent?.trim() === label)
    .map((l) => document.getElementById(l.htmlFor))
    .find((el): el is HTMLInputElement => el instanceof HTMLInputElement);
  if (!found) throw new Error(`No box labelled ${label}`);
  return found;
}

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
    // A hung server action holds Next's action queue, so Try again waits behind it; a full reload
    // is the way out, and the error says so with a link.
    const reload = Array.from(document.querySelectorAll('aside a')).find(
      (a) => a.textContent?.trim() === 'reload the page',
    );
    expect(reload?.getAttribute('href')).toBe(`/quotations/${Q}/edit`);

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

describe('quotation totals when the inputs change and change back (TR-Q8)', () => {
  it('shows a reply that answers the inputs on screen, even if its request was cleaned up meanwhile', async () => {
    vi.useFakeTimers();
    let answer: (r: unknown) => void = () => {};
    mocks.previewQuoteAction
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockResolvedValue({ ok: true, preview });
    mounted = await mountForm(builder());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.previewQuoteAction).toHaveBeenCalledTimes(1);

    await fill(discountBox('Discount %'), '10');
    await fill(discountBox('Discount %'), '');
    expect(totalsPanel()).toContain('Updating totals');

    // The first reply arrives before the next request would even be asked (600 ms after a change).
    await act(async () => {
      answer({ ok: true, preview });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(mocks.previewQuoteAction).toHaveBeenCalledTimes(1);
    expect(totalsPanel()).not.toContain('Updating totals');
    expect(totalsPanel()).toContain('1,35,600.00');
  });

  it('ignores a reply for inputs that have since changed', async () => {
    vi.useFakeTimers();
    let answer: (r: unknown) => void = () => {};
    mocks.previewQuoteAction
      .mockReturnValueOnce(new Promise((resolve) => (answer = resolve)))
      .mockReturnValue(new Promise(() => {}));
    mounted = await mountForm(builder());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    await fill(discountBox('Discount %'), '10');
    await act(async () => {
      answer({ ok: true, preview });
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(totalsPanel()).toContain('Updating totals');
  });
});

describe('quotation discount: percent and amount side by side (FX5 #5)', () => {
  const line = (key: string, description: string, quantity: string, unitPrice: string) => ({
    key,
    description,
    uom: 'lot',
    quantity,
    unitPrice,
    taxCodeId: TAX,
    unitCost: null,
    catalogItemId: null,
  });
  // Line base 5,000.00: 2 x 2,000.00 + 1 x 1,000.00. Removing line 2 leaves 4,000.00.
  const pairInitial = (): BuilderValues => ({
    ...emptyValues({ currency: 'NPR', issueDate: '2026-11-19', validUntil: '2026-12-04' }),
    lines: [line('l1', 'Design', '2', '2000.00'), line('l2', 'Support', '1', '1000.00')],
  });

  async function mountPair() {
    mocks.previewQuoteAction.mockResolvedValue({ ok: true, preview });
    mocks.saveDraftAction.mockResolvedValue({ ok: true, version: 5 });
    mounted = await mountForm(
      <QuoteBuilder
        target={EDIT}
        title="QT-2082-0042 Rev 1"
        cancelHref={`/quotations/${Q}`}
        initial={pairInitial()}
        context={null}
        contacts={[]}
        taxCodes={[]}
        paymentTerms={[]}
        enabledCurrencies={['NPR']}
        idempotencyKey="44444444-4444-4444-8444-444444444444"
      />,
    );
  }

  /** Saves, then turns the values the builder handed over into the request body's discount. */
  async function savedDiscount() {
    const save = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Save draft',
    );
    await click(save ?? null);
    expect(mocks.saveDraftAction).toHaveBeenCalledTimes(1);
    const { values } = mocks.saveDraftAction.mock.calls[0]![0] as { values: BuilderValues };
    return toContent(values, 'update').discount;
  }

  async function removeSecondLine() {
    const remove = Array.from(document.querySelectorAll('button')).find((b) =>
      b.getAttribute('aria-label')?.startsWith('Remove line 2'),
    );
    await click(remove ?? null);
    const confirm = Array.from(document.querySelectorAll('button')).find(
      (b) => b.textContent?.trim() === 'Remove line',
    );
    await click(confirm ?? null);
  }

  it('shows two labelled fields and no discount type picker', async () => {
    await mountPair();
    expect(discountBox('Discount %').value).toBe('');
    expect(discountBox('Discount amount (NPR)').value).toBe('');
    const typePicker = Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'pct'),
    );
    expect(typePicker).toBeUndefined();
  });

  it('typing 10% on a 5,000.00 base shows 500.00 as the amount and sends the percentage', async () => {
    await mountPair();
    await fill(discountBox('Discount %'), '10');
    expect(discountBox('Discount amount (NPR)').value).toBe('500.00');
    expect(await savedDiscount()).toEqual({ mode: 'pct', value: '10' });
  });

  it('typing an amount of 250 shows 5 as the percentage and sends the amount', async () => {
    await mountPair();
    await fill(discountBox('Discount amount (NPR)'), '250');
    expect(discountBox('Discount %').value).toBe('5');
    const discount = await savedDiscount();
    expect(Object.keys(discount ?? {}).sort()).toEqual(['mode', 'value']);
    expect(discount?.mode).toBe('amount');
    expect(Number(discount?.value)).toBe(250);
  });

  it('works the amount out again when the line base changes under a percentage', async () => {
    await mountPair();
    await fill(discountBox('Discount %'), '10');
    await removeSecondLine();
    expect(discountBox('Discount amount (NPR)').value).toBe('400.00');
    expect(discountBox('Discount %').value).toBe('10');
  });

  it('works the percentage out again when the line base changes under an amount', async () => {
    await mountPair();
    await fill(discountBox('Discount amount (NPR)'), '250');
    await removeSecondLine();
    expect(discountBox('Discount %').value).toBe('6.25');
    expect(await savedDiscount()).toMatchObject({ mode: 'amount' });
  });

  it('flags an amount left above a smaller base, with no percentage worked out', async () => {
    await mountPair();
    await fill(discountBox('Discount amount (NPR)'), '4500');
    expect(discountBox('Discount %').value).toBe('90');
    await removeSecondLine();
    expect(discountBox('Discount %').value).toBe('');
    expect(document.body.textContent).toContain(
      'The discount cannot be more than the subtotal of NPR 4,000.00.',
    );
  });

  it('clearing either field clears both and sends no discount', async () => {
    await mountPair();
    await fill(discountBox('Discount %'), '10');
    await fill(discountBox('Discount amount (NPR)'), '');
    expect(discountBox('Discount %').value).toBe('');
    expect(discountBox('Discount amount (NPR)').value).toBe('');
    expect(await savedDiscount()).toBeNull();
  });
});
