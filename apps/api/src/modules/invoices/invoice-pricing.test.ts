// Unit tests of the pure invoice pricing (no database). The numbers are the P3 golden case (plan section 4, check 1):
// a 1,880,000.00 line with a 5% discount and VAT 13% is taxable 1,786,000.00, VAT 232,180.00, total 2,018,180.00; and
// an order of 5,045,450.00 cut into slices that add up to the order exactly, the last one absorbing the remainder.
import { CALC_VERSION } from '@bos/money-rules';
import { describe, expect, it } from 'vitest';

import { priceInvoice, priceSlice, type InvoiceTaxCodeRow } from './invoice-pricing';

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

const line = (unitPrice: string, taxCodeId = VAT, quantity = '1') => ({
  description: 'Implementation',
  uom: 'lot',
  quantity,
  unitPrice,
  taxCodeId,
});

describe('priceInvoice', () => {
  it('prices the golden manual invoice: 1,880,000.00 less 5% with VAT 13%', () => {
    const priced = priceInvoice(
      {
        currency: 'NPR',
        asOf: '2026-11-09',
        lines: [line('1880000.00')],
        discount: { mode: 'pct', value: '5' },
      },
      periods,
    );
    expect(priced.columns).toEqual({
      subtotal: '1880000.00',
      discountAmount: '94000.00',
      taxableVatAmount: '1786000.00',
      exemptAmount: '0.00',
      zeroRatedAmount: '0.00',
      taxAmount: '232180.00',
      total: '2018180.00',
      calcVersion: CALC_VERSION,
    });
    expect(priced.lines).toEqual([
      {
        lineNo: 1,
        catalogItemId: null,
        description: 'Implementation',
        uom: 'lot',
        quantity: '1.0000',
        unitPrice: '1880000.00',
        taxCodeId: VAT,
        gross: '1880000.00',
        discountAlloc: '94000.00',
        taxable: '1786000.00',
      },
    ]);
    expect(priced.taxSummary).toEqual([
      {
        taxCodeId: VAT,
        label: 'VAT 13%',
        rate: '13.0000',
        base: '1786000.00',
        tax: '232180.00',
      },
    ]);
  });

  it('prices without a discount, and puts the exempt line in its own bucket', () => {
    const priced = priceInvoice(
      {
        currency: 'NPR',
        asOf: '2026-11-09',
        lines: [line('1786000.00'), line('100.00', EXEMPT, '3')],
        discount: null,
      },
      periods,
    );
    expect(priced.columns.discountAmount).toBe('0.00');
    expect(priced.columns.taxableVatAmount).toBe('1786000.00');
    expect(priced.columns.exemptAmount).toBe('300.00');
    expect(priced.columns.taxAmount).toBe('232180.00');
    expect(priced.columns.total).toBe('2018480.00');
    expect(priced.lines.map((l) => l.lineNo)).toEqual([1, 2]);
  });

  it('rejects a tax code id that is not among the loaded periods', () => {
    expect(() =>
      priceInvoice(
        {
          currency: 'NPR',
          asOf: '2026-11-09',
          lines: [line('1.00', '00000000-0000-4000-8000-0000000000ff')],
          discount: null,
        },
        periods,
      ),
    ).toThrow(RangeError);
  });

  it('prices a foreign-currency draft without a rate (the NPR value is frozen at issue)', () => {
    const priced = priceInvoice(
      { currency: 'USD', asOf: '2026-11-09', lines: [line('100.00')], discount: null },
      periods,
    );
    expect(priced.columns.total).toBe('113.00');
  });
});

describe('priceSlice', () => {
  const soSummary = [{ taxCodeId: VAT, base: '4465000.00', tax: '580450.00' }];
  const slice = (
    sliceTotal: string,
    billed: { taxCodeId: string; base: string; tax: string }[],
    isLast: boolean,
  ) => priceSlice({ label: 'Advance', sliceTotal, isLast, soSummary, billed }, periods);

  it('cuts the 40% advance of a 5,045,450.00 order: 2,018,180.00 with 232,180.00 VAT', () => {
    const priced = slice('2018180.00', [], false);
    expect(priced.columns).toMatchObject({
      subtotal: '1786000.00',
      discountAmount: '0.00',
      taxableVatAmount: '1786000.00',
      taxAmount: '232180.00',
      total: '2018180.00',
    });
    expect(priced.lines).toEqual([
      {
        lineNo: 1,
        catalogItemId: null,
        description: 'Advance',
        uom: 'lot',
        quantity: '1.0000',
        unitPrice: '1786000.00',
        taxCodeId: VAT,
        gross: '1786000.00',
        discountAlloc: '0.00',
        taxable: '1786000.00',
      },
    ]);
    expect(priced.taxSummary).toEqual([
      { taxCodeId: VAT, label: 'VAT 13%', rate: '13.0000', base: '1786000.00', tax: '232180.00' },
    ]);
  });

  it('cuts 60/20/20 so the last slice absorbs the remainder and the slices add up to the order', () => {
    const first = slice('3027270.00', [], false);
    const second = slice('1009090.00', first.taxSummary, false);
    const third = slice('1009090.00', [...first.taxSummary, ...second.taxSummary], true);
    expect([first, second, third].map((p) => p.columns.total)).toEqual([
      '3027270.00',
      '1009090.00',
      '1009090.00',
    ]);
    const sum = (pick: (p: typeof first) => string) =>
      [first, second, third].reduce((a, p) => a + Math.round(Number(pick(p)) * 100), 0) / 100;
    expect(sum((p) => p.columns.taxableVatAmount)).toBe(4465000);
    expect(sum((p) => p.columns.taxAmount)).toBe(580450);
    expect(sum((p) => p.columns.total)).toBe(5045450);
  });

  it('refuses a billed code that the order does not have', () => {
    expect(() =>
      slice('100.00', [{ taxCodeId: EXEMPT, base: '1.00', tax: '0.00' }], false),
    ).toThrow(RangeError);
  });
});
