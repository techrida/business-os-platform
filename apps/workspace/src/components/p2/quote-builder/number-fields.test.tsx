// @vitest-environment jsdom
// The builder's amounts, quantities and percentages use the shared number inputs: the box groups
// what is typed (12,50,000) and the form gets plain digits. A native number input would show
// 1250000 and drop grouping or decimals the user typed.
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { click, fill, mountForm } from '@/test/form-interactions';

import { emptyValues, type BuilderValues } from './model';
import { QuoteBuilder, type BuilderTarget } from './quote-builder';
import type { PreviewResult } from './schemas';

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
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
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
    discountMode: 'amount',
    discountValue: '1000',
    lines: [
      {
        key: 'l1',
        description: 'Implementation service',
        uom: 'lot',
        quantity: '2',
        unitPrice: '60000.00',
        taxCodeId: TAX,
        unitCost: null,
        catalogItemId: null,
      },
    ],
    schedule: [
      { key: 'm1', label: 'Advance', percent: '50', dueDescription: '' },
      { key: 'm2', label: 'On delivery', percent: '50', dueDescription: '' },
    ],
  };
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
  mocks.previewQuoteAction.mockResolvedValue({ ok: true, preview });
});
afterEach(async () => {
  await mounted?.unmount();
  mounted = undefined;
  document.body.innerHTML = '';
});

async function mountPriced() {
  mounted = await mountForm(
    <QuoteBuilder
      target={EDIT}
      title="QT-2082-0042 Rev 1"
      cancelHref={`/quotations/${Q}`}
      initial={initial()}
      context={null}
      contacts={[]}
      taxCodes={[{ id: TAX, label: 'VAT 13%' }]}
      paymentTerms={[]}
      enabledCurrencies={['NPR']}
      idempotencyKey="44444444-4444-4444-8444-444444444444"
    />,
  );
  // Let the first preview answer, so the milestone amounts have a total.
  await act(() => new Promise<void>((resolve) => setTimeout(resolve, 20)));
}

/** The visible boxes named by a label, in page order. */
function boxes(label: string): HTMLInputElement[] {
  return Array.from(document.querySelectorAll('label'))
    .filter((l) => l.textContent?.trim() === label)
    .map((l) => document.getElementById(l.htmlFor))
    .filter((el): el is HTMLInputElement => el instanceof HTMLInputElement);
}

function box(label: string): HTMLInputElement {
  const found = boxes(label)[0];
  if (!found) throw new Error(`No box labelled ${label}`);
  return found;
}

async function openLineEditor() {
  const edit = Array.from(document.querySelectorAll('button')).find((b) =>
    b.getAttribute('aria-label')?.startsWith('Edit line 1'),
  );
  await click(edit ?? null);
}

describe('quote builder number fields', () => {
  it('has no native number input across lines, schedule and both discount modes', async () => {
    await mountPriced();
    await openLineEditor();
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    for (const label of ['Quantity', 'Rate (NPR)', 'Discount amount (NPR)']) {
      expect(box(label).type).toBe('text');
    }
    expect(boxes('Percent (%)')).toHaveLength(2);
    expect(boxes('Amount (NPR)')).toHaveLength(2);

    const discountType = Array.from(document.querySelectorAll('select')).find((s) =>
      Array.from(s.options).some((o) => o.value === 'pct'),
    );
    await fill(discountType ?? null, 'pct');
    expect(document.querySelectorAll('input[type="number"]')).toHaveLength(0);
    expect(box('Discount (%)').type).toBe('text');
  });

  it('groups a typed rate in the box and hands the line form plain digits', async () => {
    await mountPriced();
    await openLineEditor();
    const rate = box('Rate (NPR)');
    await fill(rate, '1250000');
    expect(rate.value).toBe('12,50,000');
    const form = rate.closest('form');
    expect(form).not.toBeNull();
    expect(new FormData(form!).get('unitPrice')).toBe('1250000');
  });

  it('keeps milestone percent and amount linked both ways', async () => {
    await mountPriced();
    const [percent1] = boxes('Percent (%)');
    const [amount1, amount2] = boxes('Amount (NPR)');
    expect(amount1?.disabled).toBe(false);
    expect(amount1?.value).toBe('67,800.00');

    await fill(percent1!, '25');
    expect(amount1?.value).toBe('33,900.00');

    await fill(amount2!, '101700');
    expect(boxes('Percent (%)')[1]?.value).toBe('75');
    expect(document.body.textContent).toContain('100% / 100% allocated');
  });

  it('refuses a milestone amount above the quote total', async () => {
    await mountPriced();
    const [amount1] = boxes('Amount (NPR)');
    await fill(amount1!, '200000');
    expect(amount1?.value).toBe('67,800.00');
    expect(boxes('Percent (%)')[0]?.value).toBe('50');
  });
});
