// Unit tests of credit-note pricing (no database): a credit note is priced from the issued original's own lines, so a
// whole credit gives back the original exactly (golden case: 1,880,000.00 less 5% with VAT 13% = 2,018,180.00), a partial
// credit takes its share of the line discount and the VAT, and a line or quantity the original does not have is refused.
import { Dec } from '@bos/money-rules';
import { ConflictException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';

import { priceInvoice, type InvoiceTaxCodeRow, type PricedInvoice } from '../invoice-pricing';
import {
  creditCapExcess,
  creditsEveryLine,
  NOTHING_CREDITED,
  priceCreditNote,
  remainingToCredit,
  withNote,
  type CreditedSoFar,
  type PricedCreditNote,
  type StoredParts,
} from './note-drafting.service';

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

describe('credit notes against earlier credit notes (U12D)', () => {
  const twoCodes = () =>
    asOriginal(
      priceInvoice(
        {
          currency: 'NPR',
          asOf: '2026-11-09',
          discount: null,
          lines: [
            { description: 'Cable', uom: 'pc', quantity: '3', unitPrice: '0.05', taxCodeId: VAT },
            {
              description: 'Training',
              uom: 'day',
              quantity: '1',
              unitPrice: '1000.00',
              taxCodeId: EXEMPT,
            },
          ],
        },
        periods,
      ),
    );
  /** A priced note as the rows it stores (the fields the cap reads). */
  const stored = (note: PricedCreditNote): StoredParts => ({
    lines: note.lines.map((l) => ({
      id: `note-line-${l.lineNo}`,
      lineNo: l.lineNo,
      quantity: l.quantity,
      taxable: l.taxable,
      originalLineId: l.originalLineId,
    })),
    taxSummary: note.taxSummary,
  });
  const responseOf = (fn: () => unknown): unknown => {
    try {
      fn();
    } catch (error) {
      expect(error).toBeInstanceOf(ConflictException);
      return (error as ConflictException).getResponse();
    }
    throw new Error('expected a 409');
  };

  it('names the original line each credit-note line credits', () => {
    const original = twoCodes();
    const note = priceCreditNote(original, periods, [
      { originalLineNo: 2, quantity: '1' },
      { originalLineNo: 1, quantity: '1' },
    ]);
    expect(note.lines.map((l) => l.originalLineId)).toEqual(['line-0', 'line-1']);
  });

  it('three one-unit credits of a line add up to its VAT exactly: the completing one takes what is left', () => {
    const original = twoCodes();
    expect(original.taxSummary[0]).toMatchObject({ taxCodeId: VAT, base: '0.15', tax: '0.02' });
    let credited: CreditedSoFar = NOTHING_CREDITED;
    const vats: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const note = priceCreditNote(
        original,
        periods,
        [{ originalLineNo: 1, quantity: '1' }],
        credited,
      );
      vats.push(note.columns.taxAmount);
      credited = withNote(credited, stored(note));
    }
    expect(vats).toEqual(['0.01', '0.01', '0.00']);
    expect(credited.byTaxCode.get(VAT)).toEqual({ base: new Dec('0.15'), tax: new Dec('0.02') });
    expect(creditsEveryLine(original.lines, credited)).toBe(false);

    expect(
      responseOf(() =>
        priceCreditNote(original, periods, [{ originalLineNo: 1, quantity: '1' }], credited),
      ),
    ).toMatchObject({
      code: 'CREDIT_EXCEEDS_INVOICE',
      details: { originalLineNo: 1, remainingQuantity: '0.0000', remainingTaxable: '0.00' },
    });
    credited = withNote(
      credited,
      stored(priceCreditNote(original, periods, [{ originalLineNo: 2, quantity: '1' }], credited)),
    );
    expect(creditsEveryLine(original.lines, credited)).toBe(true);
  });

  it('a partial credit after a rounded-up one never takes more taxable than is left on the line', () => {
    // 3 x 100.00 less 1.00 of discount: a third of the discount is 0.33, so two thirds credited one at a time leave
    // 0.34 of discount and 99.66 of taxable for the last unit, which takes exactly that.
    const original = asOriginal(
      priceInvoice(
        {
          currency: 'NPR',
          asOf: '2026-11-09',
          discount: { mode: 'amount', value: '1.00' },
          lines: [
            { description: 'A', uom: 'pc', quantity: '3', unitPrice: '100.00', taxCodeId: EXEMPT },
          ],
        },
        periods,
      ),
    );
    expect(original.lines[0]).toMatchObject({ discountAlloc: '1.00', taxable: '299.00' });
    let credited: CreditedSoFar = NOTHING_CREDITED;
    const taxables: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      const note = priceCreditNote(
        original,
        periods,
        [{ originalLineNo: 1, quantity: '1' }],
        credited,
      );
      taxables.push(note.lines[0]!.taxable);
      credited = withNote(credited, stored(note));
    }
    expect(taxables).toEqual(['99.67', '99.67', '99.66']);
    expect(credited.byLine.get('line-0')).toEqual({
      quantity: new Dec(3),
      taxable: new Dec('299.00'),
    });
  });

  it('refuses a tax code with no base left even when no line is over (notes that name no line)', () => {
    const original = twoCodes();
    // Credit notes drafted before 0024 name no original line: they count only per tax code.
    const credited: CreditedSoFar = {
      byLine: new Map(),
      byTaxCode: new Map([[VAT, { base: new Dec('0.15'), tax: new Dec('0.02') }]]),
    };
    expect(
      responseOf(() =>
        priceCreditNote(original, periods, [{ originalLineNo: 1, quantity: '1' }], credited),
      ),
    ).toMatchObject({
      code: 'CREDIT_EXCEEDS_INVOICE',
      details: { taxCodeId: VAT, remainingBase: '0.00', remainingVat: '0.00' },
    });
  });

  it('creditCapExcess: a note over a line already credited names the line; within every line it is null', () => {
    const original = twoCodes();
    const parts: StoredParts = {
      lines: original.lines.map((l) => ({ ...l, originalLineId: null })),
      taxSummary: original.taxSummary,
    };
    const line1 = stored(
      priceCreditNote(original, periods, [{ originalLineNo: 1, quantity: '3' }]),
    );
    expect(creditCapExcess(parts, NOTHING_CREDITED, line1)).toBeNull();
    const before = withNote(NOTHING_CREDITED, line1);
    expect(creditCapExcess(parts, before, line1)?.getResponse()).toMatchObject({
      code: 'CREDIT_EXCEEDS_INVOICE',
      details: { originalLineNo: 1, remainingQuantity: '0.0000' },
    });
  });
});
