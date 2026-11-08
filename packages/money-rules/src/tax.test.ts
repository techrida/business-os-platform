import { describe, expect, it } from 'vitest';

import { Dec, moneyToString } from './money.js';
import { computeTaxBuckets, resolveTaxCode, type TaxCode } from './tax.js';

const VAT13: TaxCode = {
  code: 'VAT13',
  kind: 'vat',
  rateBp: 1300,
  creditable: true,
  effectiveFrom: '2000-01-01',
  effectiveTo: null,
};
const EXEMPT: TaxCode = { ...VAT13, code: 'EXEMPT', kind: 'exempt', rateBp: 0 };
const ZERO: TaxCode = { ...VAT13, code: 'ZERO', kind: 'zero', rateBp: 0 };
const RC13: TaxCode = { ...VAT13, code: 'RC13', kind: 'reverse_charge' };

const lines = (taxCode: TaxCode, ...amounts: string[]) =>
  amounts.map((taxable) => ({ taxable: new Dec(taxable), taxCode }));

describe('resolveTaxCode (effective dating)', () => {
  const v1: TaxCode = {
    ...VAT13,
    rateBp: 1000,
    effectiveFrom: '2020-01-01',
    effectiveTo: '2024-07-17',
  };
  const v2: TaxCode = { ...VAT13, rateBp: 1300, effectiveFrom: '2024-07-17', effectiveTo: null };

  it('picks the version in force on the date; the end date is exclusive', () => {
    expect(resolveTaxCode([v1, v2], 'VAT13', '2024-07-16').rateBp).toBe(1000);
    expect(resolveTaxCode([v1, v2], 'VAT13', '2024-07-17').rateBp).toBe(1300);
    expect(resolveTaxCode([v2, v1], 'VAT13', '2020-01-01').rateBp).toBe(1000);
  });

  it('throws when no version covers the date, or the code is unknown', () => {
    expect(() => resolveTaxCode([v1, v2], 'VAT13', '2019-12-31')).toThrow(RangeError);
    expect(() => resolveTaxCode([v1, v2], 'NOPE', '2024-08-01')).toThrow(RangeError);
  });

  it('throws when two versions overlap, rather than guess', () => {
    const overlapping: TaxCode = { ...v2, effectiveFrom: '2024-01-01' };
    expect(() => resolveTaxCode([v1, overlapping], 'VAT13', '2024-03-01')).toThrow(/overlap/i);
  });

  it('rejects malformed rows and dates', () => {
    const bad = (row: TaxCode) => () => resolveTaxCode([row], row.code, '2024-05-01');
    expect(bad({ ...VAT13, effectiveFrom: '2024-02-30' })).toThrow(RangeError);
    expect(() => resolveTaxCode([VAT13], 'VAT13', '01/03/2024')).toThrow(RangeError);
    expect(bad({ ...VAT13, effectiveFrom: '2024-05-01', effectiveTo: '2024-05-01' })).toThrow(
      RangeError,
    );
    expect(bad({ ...VAT13, rateBp: 13.5 })).toThrow(RangeError);
    expect(bad({ ...VAT13, rateBp: 10001 })).toThrow(RangeError);
    expect(bad({ ...EXEMPT, rateBp: 1300 })).toThrow(RangeError);
    expect(bad({ ...ZERO, rateBp: 1 })).toThrow(RangeError);
  });
});

describe('computeTaxBuckets (VAT rounded once per tax code bucket)', () => {
  it('computes VAT on the bucket sum, not per line', () => {
    // Per line: 3 x round(1.3052) = 3 x 1.31 = 3.93. Per bucket: round(30.12 x 13%) = 3.92.
    const { buckets, lineVat } = computeTaxBuckets(lines(VAT13, '10.04', '10.04', '10.04'));
    expect(buckets).toHaveLength(1);
    expect(moneyToString(buckets[0]!.vat)).toBe('3.92');
    expect(moneyToString(buckets[0]!.taxable)).toBe('30.12');
    expect(lineVat.map(moneyToString)).toEqual(['1.31', '1.31', '1.30']);
  });

  it('rounds the bucket half up', () => {
    // 0.15 x 13% = 0.0195 -> 0.02; per line 0.0065 -> 0.01 x 3 = 0.03.
    const { buckets } = computeTaxBuckets(lines(VAT13, '0.05', '0.05', '0.05'));
    expect(moneyToString(buckets[0]!.vat)).toBe('0.02');
  });

  it('spreads the bucket VAT back over its lines so they add up to it exactly', () => {
    const { buckets, lineVat } = computeTaxBuckets(
      lines(VAT13, '1800000.00', '700000.00', '7999.99'),
    );
    const sum = lineVat.reduce((a, b) => a.plus(b), new Dec(0));
    expect(sum.toFixed(2)).toBe(buckets[0]!.vat.toFixed(2));
  });

  it('keeps separate buckets per tax code and charges nothing on exempt and zero-rated lines', () => {
    const input = [
      ...lines(VAT13, '100.00'),
      ...lines(EXEMPT, '50.00'),
      ...lines(VAT13, '100.00'),
      ...lines(ZERO, '25.00'),
    ];
    const { buckets, lineVat } = computeTaxBuckets(input);
    expect(
      buckets.map((b) => [b.taxCode.code, moneyToString(b.taxable), moneyToString(b.vat)]),
    ).toEqual([
      ['VAT13', '200.00', '26.00'],
      ['EXEMPT', '50.00', '0.00'],
      ['ZERO', '25.00', '0.00'],
    ]);
    expect(lineVat.map(moneyToString)).toEqual(['13.00', '0.00', '13.00', '0.00']);
  });

  it('reverse charge: no VAT is charged on the document, the recipient-accounted VAT is reported', () => {
    const { buckets } = computeTaxBuckets(lines(RC13, '1000.00'));
    expect(moneyToString(buckets[0]!.vat)).toBe('0.00');
    expect(moneyToString(buckets[0]!.reverseChargeVat)).toBe('130.00');
  });

  it('handles an all-zero bucket and an empty document', () => {
    const { buckets } = computeTaxBuckets(lines(VAT13, '0.00'));
    expect(moneyToString(buckets[0]!.vat)).toBe('0.00');
    expect(computeTaxBuckets([])).toEqual({ buckets: [], lineVat: [] });
  });

  it('rejects a taxable amount with more than 2 decimals or a negative one', () => {
    expect(() => computeTaxBuckets(lines(VAT13, '1.005'))).toThrow(RangeError);
    expect(() => computeTaxBuckets(lines(VAT13, '-1.00'))).toThrow(RangeError);
  });
});
