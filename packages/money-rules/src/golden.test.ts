// Golden cases from the P2 and P3 architect documents. If one fails, the arithmetic is wrong,
// not the document.
import { describe, expect, it } from 'vitest';

import { allocateLargestRemainder } from './allocate.js';
import { Dec, formatMoney, moneyToString as s } from './money.js';
import { priceDocument, type LineInput } from './pricing.js';
import type { TaxCode } from './tax.js';

const common = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const taxCodes: TaxCode[] = [
  { ...common, code: 'VAT13', kind: 'vat', rateBp: 1300 },
  { ...common, code: 'EXEMPT', kind: 'exempt', rateBp: 0 },
];
const asOf = '2026-11-08';
const line = (qty: string, unitPrice: string, taxCode = 'VAT13'): LineInput => ({
  qty,
  unitPrice,
  taxCode,
});

describe('P3 golden case (R20): the one consistent sample invoice', () => {
  const priced = priceDocument(
    {
      currency: 'NPR',
      asOf,
      lines: [line('1', '1880000.00')],
      discount: { kind: 'percent', percent: '5' },
    },
    taxCodes,
  );

  it('1,880,000.00 less 5% (94,000.00) plus 13% VAT (232,180.00) is exactly 2,018,180.00', () => {
    expect(s(priced.subtotal)).toBe('1880000.00');
    expect(s(priced.documentDiscount)).toBe('94000.00');
    expect(s(priced.taxableTotal)).toBe('1786000.00');
    expect(s(priced.vatTotal)).toBe('232180.00');
    expect(s(priced.total)).toBe('2018180.00');
    expect(priced.effectiveDiscountPct).toBe('5.0000');
    expect(priced.discountApprovalRequired).toBe(false);
  });

  it('prints in lakh grouping', () => {
    expect(formatMoney(s(priced.total), 'NPR')).toBe('NPR 20,18,180.00');
  });

  it('is 40% of the NPR 5,045,450.00 sales order', () => {
    const [advance, balance] = allocateLargestRemainder(new Dec('5045450.00'), [
      new Dec(40),
      new Dec(60),
    ]);
    expect(s(advance!)).toBe('2018180.00');
    expect(s(balance!)).toBe('3027270.00');
    expect(s(advance!)).toBe(s(priced.total));
  });

  it('a 60/20/20 split of the sales order adds up to it exactly', () => {
    const parts = allocateLargestRemainder(new Dec('5045450.00'), [
      new Dec(60),
      new Dec(20),
      new Dec(20),
    ]);
    expect(parts.map(s)).toEqual(['3027270.00', '1009090.00', '1009090.00']);
  });
});

describe('P2 golden case (architect section 2.6): three lines, 8% discount, mixed VAT', () => {
  const priced = priceDocument(
    {
      currency: 'NPR',
      asOf,
      lines: [line('1', '1800000.00'), line('1', '700000.00'), line('3', '33333.33', 'EXEMPT')],
      discount: { kind: 'percent', percent: '8' },
    },
    taxCodes,
  );

  it('reproduces the documented figures to the paisa, leftover paisa to line 3', () => {
    expect(s(priced.subtotal)).toBe('2599999.99');
    expect(s(priced.documentDiscount)).toBe('208000.00');
    expect(priced.lines.map((l) => s(l.documentDiscountShare))).toEqual([
      '144000.00',
      '56000.00',
      '8000.00',
    ]);
    expect(s(priced.buckets[0]!.taxable)).toBe('2300000.00');
    expect(s(priced.vatTotal)).toBe('299000.00');
    expect(s(priced.total)).toBe('2690999.99');
    expect(priced.effectiveDiscountPct).toBe('8.0000');
    expect(priced.discountApprovalRequired).toBe(false);
  });

  it('threshold basis (C-6) is the grand total in NPR, here above NPR 10,00,000 and 2 lakh bands', () => {
    expect(s(priced.amountNpr)).toBe('2690999.99');
  });
});
