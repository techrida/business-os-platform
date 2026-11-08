import { describe, expect, it } from 'vitest';

import { moneyToString } from './money.js';
import { priceDocument, type DocInput, type LineInput } from './pricing.js';
import type { TaxCode } from './tax.js';

const base: Omit<TaxCode, 'code' | 'kind' | 'rateBp'> = {
  creditable: true,
  effectiveFrom: '2000-01-01',
  effectiveTo: null,
};
const TAX_CODES: TaxCode[] = [
  { ...base, code: 'VAT13', kind: 'vat', rateBp: 1300 },
  { ...base, code: 'EXEMPT', kind: 'exempt', rateBp: 0 },
  { ...base, code: 'ZERO', kind: 'zero', rateBp: 0 },
];

const line = (qty: string, unitPrice: string, extra: Partial<LineInput> = {}): LineInput => ({
  qty,
  unitPrice,
  taxCode: 'VAT13',
  ...extra,
});
const doc = (lines: LineInput[], extra: Partial<DocInput> = {}): DocInput => ({
  currency: 'NPR',
  asOf: '2026-11-08',
  lines,
  ...extra,
});
const price = (input: DocInput) => priceDocument(input, TAX_CODES);
const s = moneyToString;

describe('priceDocument', () => {
  it('prices one line with no discount: gross, 13% VAT, total, NPR snapshot', () => {
    const priced = price(doc([line('2.5', '1000.00')]));
    expect(s(priced.subtotal)).toBe('2500.00');
    expect(s(priced.taxableTotal)).toBe('2500.00');
    expect(s(priced.vatTotal)).toBe('325.00');
    expect(s(priced.total)).toBe('2825.00');
    expect(priced.calcVersion).toBe(1);
    expect(priced.effectiveDiscountPct).toBe('0.0000');
    expect(priced.discountApprovalRequired).toBe(false);
    expect(s(priced.amountNpr)).toBe('2825.00');
    expect(priced.npr.fxRate).toBe('1.000000');
  });

  it('rounds each line gross half up before anything else', () => {
    // 3 x 33,333.33 = 99,999.99; 0.0003 x 16.67 = 0.005001 -> 0.01.
    expect(s(price(doc([line('3', '33333.33')])).subtotal)).toBe('99999.99');
    expect(s(price(doc([line('0.0003', '16.67')])).subtotal)).toBe('0.01');
  });

  it('takes a line discount off before the header discount is spread', () => {
    const priced = price(
      doc(
        [
          line('1', '1000.00', { discount: { kind: 'percent', percent: '10' } }),
          line('1', '500.00', { discount: { kind: 'amount', amount: '50.00' } }),
        ],
        { discount: { kind: 'percent', percent: '10' } },
      ),
    );
    expect(priced.lines.map((l) => s(l.lineDiscount))).toEqual(['100.00', '50.00']);
    expect(priced.lines.map((l) => s(l.lineNet))).toEqual(['900.00', '450.00']);
    // 10% of 1,350.00 = 135.00, spread 90.00 / 45.00 on line net.
    expect(s(priced.documentDiscount)).toBe('135.00');
    expect(priced.lines.map((l) => s(l.documentDiscountShare))).toEqual(['90.00', '45.00']);
    expect(s(priced.taxableTotal)).toBe('1215.00');
    expect(s(priced.discountTotal)).toBe('285.00');
  });

  it('allocates a fixed header discount so the shares sum to it exactly', () => {
    const priced = price(
      doc([line('1', '10.00'), line('1', '10.00'), line('1', '10.00')], {
        discount: { kind: 'amount', amount: '1.00' },
      }),
    );
    expect(priced.lines.map((l) => s(l.documentDiscountShare))).toEqual(['0.34', '0.33', '0.33']);
    expect(s(priced.taxableTotal)).toBe('29.00');
  });

  it('treats different tax codes as different buckets, with VAT only on VAT lines', () => {
    const priced = price(
      doc([
        line('1', '100.00'),
        line('1', '100.00', { taxCode: 'EXEMPT' }),
        line('1', '100.00', { taxCode: 'ZERO' }),
      ]),
    );
    expect(priced.buckets.map((b) => b.taxCode.code)).toEqual(['VAT13', 'EXEMPT', 'ZERO']);
    expect(s(priced.vatTotal)).toBe('13.00');
    expect(s(priced.total)).toBe('313.00');
  });

  it('uses the tax code version in force on asOf', () => {
    const versions: TaxCode[] = [
      { ...base, code: 'VAT', kind: 'vat', rateBp: 1000, effectiveTo: '2026-01-01' },
      { ...base, code: 'VAT', kind: 'vat', rateBp: 1300, effectiveFrom: '2026-01-01' },
    ];
    const input = doc([line('1', '100.00', { taxCode: 'VAT' })], { asOf: '2025-12-31' });
    expect(s(priceDocument(input, versions).vatTotal)).toBe('10.00');
    expect(s(priceDocument({ ...input, asOf: '2026-01-01' }, versions).vatTotal)).toBe('13.00');
  });

  it('converts a USD document to an NPR snapshot with total and VAT rounded (C-2)', () => {
    const priced = price(doc([line('1', '1000.00')], { currency: 'USD', fxRate: '133.333333' }));
    expect(s(priced.total)).toBe('1130.00');
    expect(s(priced.npr.totalNpr)).toBe('150666.67');
    expect(s(priced.npr.vatNpr)).toBe('17333.33');
    expect(s(priced.npr.taxableNpr)).toBe('133333.34');
    expect(s(priced.amountNpr)).toBe('150666.67');
  });

  it('counts line discounts in the effective discount percentage', () => {
    const priced = price(
      doc([line('1', '1000.00', { discount: { kind: 'percent', percent: '12.5' } })]),
    );
    expect(priced.effectiveDiscountPct).toBe('12.5000');
    expect(priced.discountApprovalRequired).toBe(true);
  });

  it('a nominal 12% header discount can round up past 12% and then asks for approval', () => {
    // 12% of 100.05 = 12.006 -> 12.01 granted; 12.01 / 100.05 = 12.004%, so the strict rule fires.
    const priced = price(
      doc([line('1', '100.05')], { discount: { kind: 'percent', percent: '12' } }),
    );
    expect(s(priced.documentDiscount)).toBe('12.01');
    expect(priced.discountApprovalRequired).toBe(true);
    // A whole-paisa 12% does not fire.
    const exact = price(
      doc([line('1', '100.00')], { discount: { kind: 'percent', percent: '12' } }),
    );
    expect(exact.discountApprovalRequired).toBe(false);
  });

  it('handles a 100% discount (everything zero, no division trouble)', () => {
    const priced = price(
      doc([line('1', '99.99')], { discount: { kind: 'percent', percent: '100' } }),
    );
    expect(s(priced.total)).toBe('0.00');
    expect(priced.effectiveDiscountPct).toBe('100.0000');
  });

  it('handles an all-zero-price document', () => {
    const priced = price(doc([line('1', '0.00'), line('2', '0')]));
    expect(s(priced.total)).toBe('0.00');
    expect(priced.effectiveDiscountPct).toBe('0.0000');
    expect(priced.discountApprovalRequired).toBe(false);
  });

  describe('rejects invalid input instead of repairing it', () => {
    it.each([
      ['no lines', doc([])],
      ['negative unit price', doc([line('1', '-1.00')])],
      ['zero quantity', doc([line('0', '1.00')])],
      ['five-decimal quantity', doc([line('1.00001', '1.00')])],
      [
        'line discount above 100%',
        doc([line('1', '10.00', { discount: { kind: 'percent', percent: '100.01' } })]),
      ],
      [
        'negative line discount',
        doc([line('1', '10.00', { discount: { kind: 'percent', percent: '-1' } })]),
      ],
      [
        'line discount amount above gross',
        doc([line('1', '10.00', { discount: { kind: 'amount', amount: '10.01' } })]),
      ],
      [
        'document discount above the net',
        doc([line('1', '10.00')], { discount: { kind: 'amount', amount: '10.01' } }),
      ],
      [
        'three-decimal discount amount',
        doc([line('1', '10.00')], { discount: { kind: 'amount', amount: '1.005' } }),
      ],
      ['unknown tax code', doc([line('1', '10.00', { taxCode: 'VAT99' })])],
      ['USD without a rate', doc([line('1', '10.00')], { currency: 'USD' })],
      ['amount beyond numeric(18,2)', doc([line('1', '9999999999999999.99'), line('1', '1.00')])],
    ])('%s', (_name, input) => {
      expect(() => price(input)).toThrow(RangeError);
    });

    it('a JS number for money', () => {
      expect(() => price(doc([line('1', 10 as unknown as string)]))).toThrow(TypeError);
    });
  });
});
