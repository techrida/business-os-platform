// Property tests (fast-check). Oracles are independent BigInt paisa arithmetic, not the code
// under test. P3 asks for at least 10,000 runs for the balance property.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { allocateLargestRemainder } from './allocate.js';
import { Dec, roundMoney } from './money.js';
import { priceDocument, type DiscountInput, type DocInput, type LineInput } from './pricing.js';
import type { TaxCode } from './tax.js';

const common = { creditable: true, effectiveFrom: '2000-01-01', effectiveTo: null };
const taxCodes: TaxCode[] = [
  { ...common, code: 'VAT13', kind: 'vat', rateBp: 1300 },
  { ...common, code: 'EXEMPT', kind: 'exempt', rateBp: 0 },
  { ...common, code: 'ZERO', kind: 'zero', rateBp: 0 },
];
const CODES = ['VAT13', 'EXEMPT', 'ZERO'] as const;

const paisa = (value: Dec): bigint => BigInt(value.times(100).toFixed(0));
const fromPaisa = (value: bigint): string => new Dec(value.toString()).div(100).toFixed(2);

describe('allocateLargestRemainder properties', () => {
  const weights = fc
    .array(fc.bigInt({ min: 0n, max: 10n ** 12n }), { minLength: 1, maxLength: 40 })
    .filter((w) => w.some((x) => x > 0n));

  it('parts sum exactly to the total, each within one paisa of its exact share', () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: 10n ** 15n }), weights, (total, ws) => {
        const parts = allocateLargestRemainder(
          new Dec(fromPaisa(total)),
          ws.map((w) => new Dec(w.toString())),
        ).map(paisa);
        const weightSum = ws.reduce((a, b) => a + b, 0n);
        expect(parts.reduce((a, b) => a + b, 0n)).toBe(total);
        parts.forEach((part, i) => {
          const exact = total * ws[i]!;
          // floor(exact share) <= part <= ceil(exact share), compared without dividing
          expect(part * weightSum).toBeGreaterThanOrEqual(exact - weightSum + 1n);
          expect(part * weightSum).toBeLessThanOrEqual(exact + weightSum - 1n);
          if (ws[i] === 0n) expect(part).toBe(0n);
        });
      }),
      { numRuns: 10000 },
    );
  });

  it('is order-stable: equal weights give the extra paisa to the lowest indexes', () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10n ** 9n }),
        fc.integer({ min: 1, max: 30 }),
        (total, n) => {
          const parts = allocateLargestRemainder(
            new Dec(fromPaisa(total)),
            Array.from({ length: n }, () => new Dec(1)),
          ).map(paisa);
          for (let i = 1; i < n; i += 1) expect(parts[i - 1]! >= parts[i]!).toBe(true);
          expect(parts[0]! - parts[n - 1]! <= 1n).toBe(true);
        },
      ),
      { numRuns: 2000 },
    );
  });
});

describe('roundMoney properties', () => {
  const decimalText = fc
    .tuple(fc.bigInt({ min: -(10n ** 15n), max: 10n ** 15n }), fc.integer({ min: 0, max: 6 }))
    .map(([n, dp]) => new Dec(n.toString()).div(new Dec(10).pow(dp)));

  it('is within half a paisa, idempotent, and ties move away from zero', () => {
    fc.assert(
      fc.property(decimalText, (x) => {
        const r = roundMoney(x);
        expect(r.decimalPlaces()).toBeLessThanOrEqual(2);
        expect(r.minus(x).abs().lte('0.005')).toBe(true);
        expect(roundMoney(r).eq(r)).toBe(true);
        const twiceTie = x.times(100).minus(x.times(100).trunc()).abs().eq('0.5');
        if (twiceTie) expect(r.abs().gt(x.abs())).toBe(true);
      }),
      { numRuns: 10000 },
    );
  });
});

// ---- priceDocument ----------------------------------------------------------------------

const discountArb = fc.record({
  kind: fc.constantFrom('none', 'percent', 'amount'),
  bp: fc.integer({ min: 0, max: 10000 }),
});

function toDiscount(raw: { kind: string; bp: number }, base: Dec): DiscountInput | undefined {
  if (raw.kind === 'none') return undefined;
  if (raw.kind === 'percent')
    return { kind: 'percent', percent: new Dec(raw.bp).div(100).toString() };
  return { kind: 'amount', amount: roundMoney(base.times(raw.bp).div(10000)).toFixed(2) };
}

const lineArb = fc.record({
  qty4: fc.integer({ min: 1, max: 10_000_000_000 }), // 0.0001 to 1,000,000.0000
  priceCents: fc.integer({ min: 0, max: 10_000_000_000 }), // 0 to 100,000,000.00
  code: fc.constantFrom(...CODES),
  discount: discountArb,
});

const docArb = fc.record({
  lines: fc.array(lineArb, { minLength: 1, maxLength: 60 }),
  discount: discountArb,
  currency: fc.constantFrom('NPR', 'USD', 'INR'),
  rate6: fc.integer({ min: 10_000, max: 500_000_000 }), // 0.01 to 500.000000
});

type RawDoc = typeof docArb extends fc.Arbitrary<infer T> ? T : never;

function buildDoc(raw: RawDoc): DocInput {
  const lines: LineInput[] = raw.lines.map((l) => {
    const qty = new Dec(l.qty4).div(10000);
    const unit = new Dec(l.priceCents).div(100);
    const gross = roundMoney(qty.times(unit));
    const discount = toDiscount(l.discount, gross);
    return {
      qty: qty.toFixed(4),
      unitPrice: unit.toFixed(2),
      taxCode: l.code,
      ...(discount === undefined ? {} : { discount }),
    };
  });
  const base: DocInput = { currency: 'NPR', asOf: '2026-11-08', lines };
  const net = priceDocument(base, taxCodes);
  const headerBase = net.subtotal.minus(net.lineDiscountTotal);
  const header = toDiscount(raw.discount, headerBase);
  const currency = raw.currency;
  return {
    ...base,
    currency,
    ...(header === undefined ? {} : { discount: header }),
    ...(currency === 'NPR' ? {} : { fxRate: new Dec(raw.rate6).div(1_000_000).toFixed(6) }),
  };
}

describe('priceDocument properties (P3 P1 "balance", 10,000 runs)', () => {
  it('totals balance, discount shares and VAT shares add up, nothing is negative', () => {
    fc.assert(
      fc.property(docArb, (raw) => {
        const p = priceDocument(buildDoc(raw), taxCodes);
        const sum = (xs: Dec[]) => xs.reduce((a, b) => a.plus(b), new Dec(0));

        // Dr total = Cr (revenue net of discount + VAT); total = taxable + VAT
        expect(p.total.eq(p.taxableTotal.plus(p.vatTotal))).toBe(true);
        // the discount shares add up to the header discount exactly
        expect(sum(p.lines.map((l) => l.documentDiscountShare)).eq(p.documentDiscount)).toBe(true);
        // everything is taken off the subtotal and nothing else
        expect(p.subtotal.minus(p.discountTotal).eq(p.taxableTotal)).toBe(true);
        // line VAT adds up to the bucket VAT, and buckets to the document VAT
        expect(sum(p.lines.map((l) => l.vat)).eq(p.vatTotal)).toBe(true);
        for (const bucket of p.buckets) {
          const lineSum = sum(
            p.lines.filter((l) => l.taxCode === bucket.taxCode.code).map((l) => l.vat),
          );
          expect(lineSum.eq(bucket.vat)).toBe(true);
          // independent oracle: round-half-up of taxable x bp / 10000 in whole paisa
          const expected =
            bucket.taxCode.kind === 'vat'
              ? (paisa(bucket.taxable) * BigInt(bucket.taxCode.rateBp) + 5000n) / 10000n
              : 0n;
          expect(paisa(bucket.vat)).toBe(expected);
        }
        // no negative amounts anywhere
        for (const l of p.lines) {
          for (const v of [
            l.gross,
            l.lineDiscount,
            l.lineNet,
            l.documentDiscountShare,
            l.taxable,
            l.vat,
          ]) {
            expect(v.isNegative()).toBe(false);
          }
        }
        // NPR snapshot: total = taxable + VAT, in rupees too
        expect(p.npr.totalNpr.eq(p.npr.taxableNpr.plus(p.npr.vatNpr))).toBe(true);
        expect(p.npr.vatNpr.isNegative() || p.npr.taxableNpr.isNegative()).toBe(false);
        // the approval trigger is the exact rational comparison, never the stored text
        const trigger = paisa(p.discountTotal) * 100n > 12n * paisa(p.subtotal);
        expect(p.discountApprovalRequired).toBe(trigger);
      }),
      { numRuns: 10000 },
    );
  }, 120_000);
});
