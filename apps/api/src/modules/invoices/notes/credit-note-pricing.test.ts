// Unit tests of credit-note pricing (no database): a credit note is priced from the issued original's own lines, so a
// whole credit gives back the original exactly (golden case: 1,880,000.00 less 5% with VAT 13% = 2,018,180.00), a partial
// credit takes its share of the line discount and the VAT, and a line or quantity the original does not have is refused.
import { describe, expect, it } from 'vitest';

import { priceInvoice, type InvoiceTaxCodeRow, type PricedInvoice } from '../invoice-pricing';
import { priceCreditNote, remainingToCredit } from './note-drafting.service';

const VAT = '00000000-0000-4000-8000-0000000000a1';
const EXEMPT = '00000000-0000-4000-8000-0000000000a2';
const periods: InvoiceTaxCodeRow[] = [
  {
    id: VAT,
    code: 'VAT13',
    name: 'VAT 13%',
    kind: 'vat',
    rateBp: 1300,
    creditable: true,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
  {
    id: EXEMPT,
    code: 'EXEMPT',
    name: 'Exempt',
    kind: 'exempt',
    rateBp: 0,
    creditable: false,
    effectiveFrom: '2020-01-01',
    effectiveTo: null,
  },
];

type Original = Parameters<typeof priceCreditNote>[0];

/** The rows an issued invoice priced by `priceInvoice` has (only the fields pricing reads). */
function asOriginal(priced: PricedInvoice): Original {
  return {
    lines: priced.lines.map((l, i) => ({ ...l, id: `line-${i}` })),
    taxSummary: priced.taxSummary.map((t) => ({ ...t })),
  } as unknown as Original;
}

const golden = () =>
  priceInvoice(
    {
      currency: 'NPR',
      asOf: '2026-11-09',
      discount: { mode: 'pct', value: '5' },
      lines: [
        {
          description: 'Implementation',
          uom: 'lot',
          quantity: '4',
          unitPrice: '470000.00',
          taxCodeId: VAT,
        },
      ],
    },
    periods,
  );

describe('priceCreditNote', () => {
  it('a whole credit gives back the original exactly', () => {
    const original = golden();
    expect(original.columns.total).toBe('2018180.00');
    const note = priceCreditNote(asOriginal(original), periods, [
      { originalLineNo: 1, quantity: '4' },
    ]);
    expect(note.columns).toEqual(original.columns);
    expect(note.lines[0]).toMatchObject({
      quantity: '4.0000',
      unitPrice: '470000.00',
      gross: '1880000.00',
      discountAlloc: '94000.00',
      taxable: '1786000.00',
    });
    expect(note.taxSummary).toEqual([
      { taxCodeId: VAT, label: 'VAT 13%', rate: '13.0000', base: '1786000.00', tax: '232180.00' },
    ]);
  });

  it('a partial credit takes its share of the discount and the VAT', () => {
    const note = priceCreditNote(asOriginal(golden()), periods, [
      { originalLineNo: 1, quantity: '1' },
    ]);
    expect(note.lines[0]).toMatchObject({
      gross: '470000.00',
      discountAlloc: '23500.00',
      taxable: '446500.00',
    });
    expect(note.columns).toMatchObject({
      subtotal: '470000.00',
      discountAmount: '23500.00',
      taxableVatAmount: '446500.00',
      taxAmount: '58045.00',
      total: '504545.00',
    });
  });

  it('credits only the lines named and keeps each line on its own tax code', () => {
    const original = priceInvoice(
      {
        currency: 'NPR',
        asOf: '2026-11-09',
        discount: null,
        lines: [
          { description: 'A', uom: 'pc', quantity: '2', unitPrice: '100.00', taxCodeId: VAT },
          { description: 'B', uom: 'pc', quantity: '1', unitPrice: '50.00', taxCodeId: EXEMPT },
        ],
      },
      periods,
    );
    const note = priceCreditNote(asOriginal(original), periods, [
      { originalLineNo: 2, quantity: '1' },
    ]);
    expect(note.lines).toHaveLength(1);
    expect(note.lines[0]).toMatchObject({ lineNo: 1, description: 'B', taxCodeId: EXEMPT });
    expect(note.taxSummary.map((t) => t.taxCodeId)).toEqual([EXEMPT]);
    expect(note.columns).toMatchObject({
      exemptAmount: '50.00',
      taxAmount: '0.00',
      total: '50.00',
    });
  });

  it('refuses a quantity above the original line and a line the original does not have', () => {
    const original = asOriginal(golden());
    expect(() =>
      priceCreditNote(original, periods, [{ originalLineNo: 1, quantity: '5' }]),
    ).toThrow(RangeError);
    expect(() =>
      priceCreditNote(original, periods, [{ originalLineNo: 2, quantity: '1' }]),
    ).toThrow(RangeError);
  });
});

describe('remainingToCredit', () => {
  it('is the total less the live credits, never below zero', () => {
    expect(remainingToCredit('2018180.00', '0').toFixed(2)).toBe('2018180.00');
    expect(remainingToCredit('2018180.00', '504545.00').toFixed(2)).toBe('1513635.00');
    expect(remainingToCredit('100.00', '150.00').toFixed(2)).toBe('0.00');
  });
});
