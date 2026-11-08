// Unit tests of the pure part of the preview: the request body becomes a PricingInput, and the priced version
// becomes the PreviewResult the workspace parses. The figures come from the real priceQuotation (no database), and
// every result is parsed with the same PreviewResultSchema the workspace uses, so a field the builder drops, a
// rounded fact in the wrong place or an NPR snapshot on an NPR document fails here.
import { PreviewResultSchema, type QuotationPreviewBody, type RoutePlan } from '@bos/contracts';
import { describe, expect, it } from 'vitest';

import { priceQuotation, type FxSnapshot } from '../pricing/pricing';
import type { TaxCodeRow } from '../pricing/tax-codes.resolver';
import { approvalFactsOf, previewResultOf, toPricingInput } from './preview-result';

const VAT_ID = '6f1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e11';
const EXEMPT_ID = '7a1c2a52-9a7e-4c41-8f6e-2b1a1d0c9e12';
const always = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const PERIODS: TaxCodeRow[] = [
  { ...always, id: VAT_ID, code: 'VAT13', name: 'VAT 13%', kind: 'vat', rateBp: 1300 },
  { ...always, id: EXEMPT_ID, code: 'EXEMPT', name: 'Exempt', kind: 'exempt', rateBp: 0 },
];
const NPR_FX: FxSnapshot = { rate: '1', source: null, date: null };
const ROUTE: RoutePlan = { steps: [], blocked: false };

const body = (extra: Partial<QuotationPreviewBody> = {}): QuotationPreviewBody => ({
  currency: 'NPR',
  lines: [
    { description: 'Design', uom: 'job', quantity: '3', unitPrice: '33333.33', taxCodeId: VAT_ID },
    {
      description: 'Hosting',
      uom: 'year',
      quantity: '1',
      unitPrice: '12000.00',
      unitCost: '9000.00',
      taxCodeId: EXEMPT_ID,
    },
  ],
  ...extra,
});

const price = (b: QuotationPreviewBody, fx: FxSnapshot = NPR_FX) =>
  priceQuotation(toPricingInput(b, '2026-11-09'), PERIODS, fx);

describe('toPricingInput', () => {
  it('numbers the lines from 1 and takes the issue date from the saved version', () => {
    const input = toPricingInput(body(), '2026-11-09');
    expect(input.issueDate).toBe('2026-11-09');
    expect(input.lines.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(input.lines[0]).toMatchObject({ catalogItemId: null, unitCost: null });
    expect(input.lines[1]).toMatchObject({ unitCost: '9000.00' });
  });

  it('prices no discount when the body has none: a removed discount must change the preview', () => {
    expect(toPricingInput(body(), '2026-11-09').discount).toBeNull();
    const withDiscount = toPricingInput(
      body({ discount: { mode: 'pct', value: '10' } }),
      '2026-11-09',
    );
    expect(withDiscount.discount).toEqual({ mode: 'pct', value: '10' });
  });
});

describe('previewResultOf', () => {
  it('builds a result the workspace schema accepts, NPR without a snapshot', () => {
    const result = previewResultOf(price(body({ discount: { mode: 'pct', value: '5' } })), ROUTE);
    const parsed = PreviewResultSchema.parse(result);
    expect(parsed.nprSnapshot).toBeNull();
    expect(parsed.totals).toMatchObject({
      discountAmount: expect.stringMatching(/^\d+\.\d{2}$/) as string,
      effectiveDiscountPct: '5.0000',
    });
    expect(parsed.lines?.map((l) => l.lineNo)).toEqual([1, 2]);
    expect(parsed.taxSummary.map((t) => [t.taxCodeId, t.label])).toEqual([
      [VAT_ID, 'VAT 13%'],
      [EXEMPT_ID, 'Exempt'],
    ]);
    expect(parsed.route).toEqual(ROUTE);
  });

  it('shows the rounded 4-decimal percentage in the totals, never the unrounded fact', () => {
    const priced = price(body({ discount: { mode: 'amount', value: '37333.33' } }));
    expect(priced.facts.effectiveDiscountPct).not.toBe(priced.columns.effectiveDiscountPct);
    const result = previewResultOf(priced, ROUTE);
    expect(result.totals.effectiveDiscountPct).toBe(priced.columns.effectiveDiscountPct);
    expect(PreviewResultSchema.safeParse(result).success).toBe(true);
  });

  it('adds the NPR snapshot for a foreign currency, from the frozen rate', () => {
    const priced = price(body({ currency: 'USD' }), {
      rate: '133.500000',
      source: 'NRB',
      date: '2026-11-09',
    });
    const parsed = PreviewResultSchema.parse(previewResultOf(priced, ROUTE));
    expect(parsed.nprSnapshot).toEqual({
      amountNpr: priced.columns.amountNpr,
      rate: '133.500000',
      rateSource: 'NRB',
      rateDate: '2026-11-09',
    });
  });
});

describe('approvalFactsOf', () => {
  it('passes the amount, the unrounded discount percentage and the exact discount flag', () => {
    const priced = price(body({ discount: { mode: 'amount', value: '37333.33' } }));
    const facts = approvalFactsOf(priced.facts);
    expect(facts).toEqual({
      amountNpr: priced.facts.amountNpr,
      effectiveDiscountPct: priced.facts.effectiveDiscountPct,
      discountApprovalRequired: true,
    });
    expect(typeof facts.amountNpr).toBe('string');
    expect(typeof facts.effectiveDiscountPct).toBe('string');
  });

  it('flags a discount of exactly 12% as not requiring approval (strictly above)', () => {
    // One line of 100,000.00: 12% is 12,000.00 to the paisa, so it is exactly 12 and not above it.
    const exact = (value: string) =>
      approvalFactsOf(
        price({
          currency: 'NPR',
          lines: [
            {
              description: 'Work',
              uom: 'job',
              quantity: '1',
              unitPrice: '100000.00',
              taxCodeId: VAT_ID,
            },
          ],
          discount: { mode: 'pct', value },
        }).facts,
      );
    expect(exact('12').discountApprovalRequired).toBe(false);
    expect(exact('12.0100').discountApprovalRequired).toBe(true);
  });
});
