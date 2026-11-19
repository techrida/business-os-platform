// splitSchedule and invoiceSlice. Expected figures come from the P3 golden case (R20) and from
// BigInt paisa sums, never from the code under test.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { Dec, moneyToString as s } from './money.js';
import { priceDocument } from './pricing.js';
import { invoiceSlice, splitSchedule, type SliceAmounts } from './schedule.js';
import type { TaxBucket, TaxCode } from './tax.js';

const common = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const VAT13: TaxCode = { ...common, code: 'VAT13', kind: 'vat', rateBp: 1300 };
const EXEMPT: TaxCode = { ...common, code: 'EXEMPT', kind: 'exempt', rateBp: 0 };
const RC13: TaxCode = { ...common, code: 'RC13', kind: 'reverse_charge', rateBp: 1300 };
const taxCodes = [VAT13, EXEMPT, RC13];

const d = (text: string) => new Dec(text);
const paisa = (value: Dec): bigint => BigInt(value.times(100).toFixed(0));
const fromPaisa = (value: bigint): Dec => new Dec(value.toString()).div(100);
const bucket = (taxCode: TaxCode, taxable: string, vat: string, rc = '0'): TaxBucket => ({
  taxCode,
  taxable: d(taxable),
  vat: d(vat),
  reverseChargeVat: d(rc),
});

/** The R20 sales order: one VAT13 line of 4,465,000.00, so VAT 580,450.00, total 5,045,450.00. */
const so = priceDocument(
  {
    currency: 'NPR',
    asOf: '2026-11-08',
    lines: [{ qty: '1', unitPrice: '4465000.00', taxCode: 'VAT13' }],
  },
  taxCodes,
);

describe('splitSchedule', () => {
  it('splits the R20 sales order 60/20/20 into 3,027,270.00 / 1,009,090.00 / 1,009,090.00', () => {
    expect(s(so.total)).toBe('5045450.00');
    expect(splitSchedule(so.total, [d('60'), d('20'), d('20')]).map(s)).toEqual([
      '3027270.00',
      '1009090.00',
      '1009090.00',
    ]);
  });

  it('gives the remainder to the last line after rounding the earlier shares', () => {
    // The last line absorbs the excess when the rounded earlier lines consume more than their exact shares.
    expect(splitSchedule(d('100.01'), [d('33.3333'), d('33.3333'), d('33.3334')]).map(s)).toEqual([
      '33.34',
      '33.34',
      '33.33',
    ]);
    expect(splitSchedule(d('0.01'), [d('50'), d('50')]).map(s)).toEqual(['0.01', '0.00']);
  });

  it('refuses percents that do not add up to exactly 100, negative percents and no lines', () => {
    expect(() => splitSchedule(d('100.00'), [d('60'), d('20'), d('19.99')])).toThrow(RangeError);
    expect(() => splitSchedule(d('100.00'), [d('60'), d('20'), d('20.01')])).toThrow(RangeError);
    expect(() => splitSchedule(d('100.00'), [d('120'), d('-20')])).toThrow(RangeError);
    expect(() => splitSchedule(d('100.00'), [])).toThrow(RangeError);
  });

  it('refuses a negative total or one with more than 2 decimals', () => {
    expect(() => splitSchedule(d('-1.00'), [d('100')])).toThrow(RangeError);
    expect(() => splitSchedule(d('1.001'), [d('100')])).toThrow(RangeError);
  });
});

describe('invoiceSlice: the R20 advance and balance', () => {
  const [advanceLine, balanceLine] = splitSchedule(so.total, [d('40'), d('60')]);
  const advance = invoiceSlice(so.buckets, advanceLine!, [], false);

  it('a 40% advance is taxable 1,786,000.00, VAT 232,180.00, total 2,018,180.00', () => {
    expect(s(advance.buckets[0]!.taxable)).toBe('1786000.00');
    expect(s(advance.buckets[0]!.vat)).toBe('232180.00');
    expect(s(advance.taxableTotal)).toBe('1786000.00');
    expect(s(advance.vatTotal)).toBe('232180.00');
    expect(s(advance.total)).toBe('2018180.00');
  });

  it('the last slice is the rest: taxable 2,679,000.00, VAT 348,270.00, total 3,027,270.00', () => {
    const balance = invoiceSlice(so.buckets, balanceLine!, advance.buckets, true);
    expect(s(balance.taxableTotal)).toBe('2679000.00');
    expect(s(balance.vatTotal)).toBe('348270.00');
    expect(s(balance.total)).toBe('3027270.00');
  });
});

describe('invoiceSlice: absorbing rounding and refusing bad input', () => {
  // VAT 13% of 100.01 is 13.0013 -> 13.00; with the 0.01 exempt bucket the SO total is 113.02.
  const soBuckets = [bucket(VAT13, '100.01', '13.00'), bucket(EXEMPT, '0.01', '0')];

  it('keeps every non-last slice at its schedule amount and lets the last one absorb the rest', () => {
    const lines = splitSchedule(d('113.02'), [d('33'), d('33'), d('34')]).map(s);
    // The two 33% lines each round to 37.30. The third gets the remaining 38.42.
    expect(lines).toEqual(['37.30', '37.30', '38.42']);
    const first = invoiceSlice(soBuckets, d(lines[0]!), [], false);
    const second = invoiceSlice(soBuckets, d(lines[1]!), first.buckets, false);
    const last = invoiceSlice(soBuckets, d(lines[2]!), [...first.buckets, ...second.buckets], true);
    expect([first, second, last].map((x) => s(x.total))).toEqual(lines);
    const vat = [first, second, last].map((x) => paisa(x.buckets[0]!.vat));
    expect(vat.reduce((a, b) => a + b, 0n)).toBe(1300n);
    const exempt = [first, second, last].map((x) => paisa(x.buckets[1]!.taxable));
    expect(exempt.reduce((a, b) => a + b, 0n)).toBe(1n);
  });

  it('carries reverse-charge VAT with its taxable share, outside the total', () => {
    const rcBuckets = [bucket(RC13, '1000.00', '0', '130.00')];
    const first = invoiceSlice(rcBuckets, d('400.00'), [], false);
    expect(s(first.buckets[0]!.reverseChargeVat)).toBe('52.00');
    expect(s(first.total)).toBe('400.00');
    const last = invoiceSlice(rcBuckets, d('600.00'), first.buckets, true);
    expect(s(last.buckets[0]!.reverseChargeVat)).toBe('78.00');
  });

  it('refuses a billed tax code the sales order does not have', () => {
    expect(() => invoiceSlice(soBuckets, d('1.00'), [bucket(RC13, '1.00', '0')], false)).toThrow(
      RangeError,
    );
  });

  it('refuses a sales order that is already billed beyond a bucket', () => {
    expect(() =>
      invoiceSlice(soBuckets, d('1.00'), [bucket(VAT13, '100.02', '13.00')], true),
    ).toThrow(RangeError);
  });

  it('refuses a non-last slice larger than what is still unbilled', () => {
    expect(() => invoiceSlice(soBuckets, d('113.03'), [], false)).toThrow(RangeError);
    expect(() =>
      invoiceSlice(soBuckets, d('100.00'), [bucket(VAT13, '20.00', '2.60')], false),
    ).toThrow(RangeError);
  });
});

describe('invoiceSlice properties', () => {
  const component = fc.oneof(
    fc.bigInt({ min: 0n, max: 3n }), // tiny buckets, where absorbing could go negative
    fc.bigInt({ min: 0n, max: 10n ** 12n }),
  );
  const soArb = fc
    .record({
      vatTaxable: component,
      vat: component,
      exempt: component,
      rcTaxable: component,
      rc: component,
    })
    .filter((x) => x.vatTaxable + x.vat + x.exempt + x.rcTaxable > 0n);
  /** 1 to 6 schedule lines with whole percents adding up to 100, and an issue order. */
  const planArb = fc
    .uniqueArray(fc.integer({ min: 1, max: 99 }), { maxLength: 5 })
    .map((cuts) => {
      const points = [0, ...[...cuts].sort((a, b) => a - b), 100];
      return points.slice(1).map((p, i) => p - points[i]!);
    })
    .chain((percents) =>
      fc
        .shuffledSubarray(
          percents.map((_, i) => i),
          { minLength: percents.length, maxLength: percents.length },
        )
        .map((order) => ({ percents, order })),
    );

  it('slices add up to every SO bucket exactly, whatever the issue order', () => {
    fc.assert(
      fc.property(soArb, planArb, (x, { percents, order }) => {
        const soBuckets = [
          bucket(VAT13, s(fromPaisa(x.vatTaxable)), s(fromPaisa(x.vat))),
          bucket(EXEMPT, s(fromPaisa(x.exempt)), '0'),
          bucket(RC13, s(fromPaisa(x.rcTaxable)), '0', s(fromPaisa(x.rc))),
        ];
        const soTotal = x.vatTaxable + x.vat + x.exempt + x.rcTaxable;
        const lines = splitSchedule(
          fromPaisa(soTotal),
          percents.map((p) => new Dec(p)),
        );

        const issued: SliceAmounts[] = [];
        order.forEach((lineIndex, k) => {
          const isLast = k === order.length - 1;
          const slice = invoiceSlice(
            soBuckets,
            lines[lineIndex]!,
            issued.flatMap((i) => i.buckets),
            isLast,
          );
          // Every slice is the amount of its schedule line, the last one included.
          expect(paisa(slice.total)).toBe(paisa(lines[lineIndex]!));
          for (const b of slice.buckets) {
            expect(b.taxable.isNegative() || b.vat.isNegative()).toBe(false);
            expect(b.reverseChargeVat.isNegative()).toBe(false);
          }
          issued.push(slice);
        });

        const sumOf = (i: number, pick: (b: TaxBucket) => Dec) =>
          issued.reduce((acc, slice) => acc + paisa(pick(slice.buckets[i]!)), 0n);
        expect(sumOf(0, (b) => b.taxable)).toBe(x.vatTaxable);
        expect(sumOf(0, (b) => b.vat)).toBe(x.vat);
        expect(sumOf(1, (b) => b.taxable)).toBe(x.exempt);
        expect(sumOf(2, (b) => b.taxable)).toBe(x.rcTaxable);
        expect(sumOf(2, (b) => b.reverseChargeVat)).toBe(x.rc);
      }),
      { numRuns: 2000 },
    );
  });
});
