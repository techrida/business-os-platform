// Unit tests of the NPR bucket split behind the sales VAT register (no database). Buckets are taxable, VAT, exempt and
// zero-rated, unsigned; the register signs a credit note's row after the split.
import { Dec } from '@bos/money-rules';
import { describe, expect, it } from 'vitest';

import { allocateNprBuckets } from './invoice-vat-npr-allocation';

const split = (buckets: string[], rate: string, total: string) =>
  allocateNprBuckets(
    buckets.map((b) => new Dec(b)),
    new Dec(rate),
    new Dec(total),
  ).map((x) => x.toFixed(2));

/** The split the register used before: each bucket rounded half-up, the whole remainder on the largest bucket. */
function previousSplit(buckets: Dec[], rate: Dec, total: Dec): Dec[] {
  const converted = buckets.map((x) => x.times(rate).toDecimalPlaces(2, Dec.ROUND_HALF_UP));
  const remainder = total.minus(Dec.sum(...converted));
  if (!remainder.isZero()) {
    let target = 0;
    buckets.forEach((x, i) => {
      if (!x.isZero() && (buckets[target]!.isZero() || x.gt(buckets[target]!))) target = i;
    });
    converted[target] = converted[target]!.plus(remainder);
  }
  return converted;
}

/** A small seeded generator, so a failure names a case that can be replayed. */
function generator(seed: number) {
  let state = seed >>> 0;
  return (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % n;
  };
}

describe('allocateNprBuckets', () => {
  it('keeps a closing credit note from flipping a bucket: 0.01 exempt + 0.01 zero-rated INR at 1.6, 0.01 NPR left (FU11 follow-up)', () => {
    // The run: a 0.07 INR invoice at 1.6 (0.11 NPR), five 0.01 INR credits of 0.02 NPR each, then the closing credit
    // takes the 0.01 NPR left. Each bucket alone converts to 0.02; the previous split gave exempt -0.01 (+0.01 once
    // the credit note's sign was applied) and zero-rated 0.02.
    expect(split(['0.00', '0.00', '0.01', '0.01'], '1.6', '0.01')).toEqual([
      '0.00',
      '0.00',
      '0.00',
      '0.01',
    ]);
    expect(
      previousSplit(
        ['0.00', '0.00', '0.01', '0.01'].map((b) => new Dec(b)),
        new Dec('1.6'),
        new Dec('0.01'),
      ).map((x) => x.toFixed(2)),
    ).toEqual(['0.00', '0.00', '-0.01', '0.02']);
    // The rest of the run splits as before.
    expect(split(['0.05', '0.00', '0.01', '0.01'], '1.6', '0.11')).toEqual([
      '0.07',
      '0.00',
      '0.02',
      '0.02',
    ]);
    expect(split(['0.01', '0.00', '0.00', '0.00'], '1.6', '0.02')).toEqual([
      '0.02',
      '0.00',
      '0.00',
      '0.00',
    ]);
  });

  it('puts the remainder on the largest bucket, equal sizes in bucket order, as the register always did', () => {
    expect(split(['0.00', '0.00', '0.01', '0.01'], '1.6', '0.03')).toEqual([
      '0.00',
      '0.00',
      '0.01',
      '0.02',
    ]);
    expect(split(['33.33', '4.33', '0.00', '0.00'], '133.5', '5027.61')).toEqual([
      '4449.55',
      '578.06',
      '0.00',
      '0.00',
    ]);
    expect(split(['1000.00', '130.00', '250.50', '0.00'], '1.6', '2208.80')).toEqual([
      '1600.00',
      '208.00',
      '400.80',
      '0.00',
    ]);
    // Rounded once at full precision: .00499999 of a cent is .00.
    expect(
      split(['0.00', '10000000004999.99', '0.00', '0.00'], '100.000001', '1000000010499999.00'),
    ).toEqual(['0.00', '1000000010499999.00', '0.00', '0.00']);
  });

  it("spreads a total larger than the converted buckets up to each bucket's proportional ceiling", () => {
    // 0.016 + 0.016 NPR of buckets carrying 0.05 NPR: neither bucket may take more than ceil(0.025) = 0.03.
    expect(split(['0.00', '0.00', '0.01', '0.01'], '1.6', '0.05')).toEqual([
      '0.00',
      '0.00',
      '0.03',
      '0.02',
    ]);
  });

  it('refuses negative or sub-cent inputs and a non-positive rate', () => {
    expect(() => split(['-0.01', '0', '0', '0'], '1.6', '0.00')).toThrow(RangeError);
    expect(() => split(['0.001', '0', '0', '0'], '1.6', '0.00')).toThrow(RangeError);
    expect(() => split(['0.01', '0', '0', '0'], '1.6', '-0.02')).toThrow(RangeError);
    expect(() => split(['0.01', '0', '0', '0'], '0', '0.00')).toThrow(RangeError);
  });

  it('over many small documents: adds up, keeps zero buckets zero, stays within every ceiling, is repeatable and matches the previous split wherever that was valid', () => {
    const next = generator(20261123);
    const rates = ['1.6', '1.5', '1.05', '133.5', '133.456789', '1', '0.75'];
    let compared = 0;
    for (let n = 0; n < 5000; n += 1) {
      const buckets = Array.from({ length: 4 }, () =>
        next(3) === 0 ? new Dec(0) : new Dec(next(40)).dividedBy(100),
      );
      const rate = new Dec(rates[next(rates.length)]!);
      const exact = buckets.reduce((a, b) => a.plus(b.times(rate)), new Dec(0));
      const converted = exact.toDecimalPlaces(2, Dec.ROUND_HALF_UP);
      // Half the cases freeze the converted total (an invoice or a partial credit); the rest are a closing credit's
      // leftover anywhere from zero to a few cents past it.
      const total = exact.isZero()
        ? new Dec(0)
        : next(2) === 0
          ? converted
          : new Dec(next(converted.times(100).toNumber() + 6)).dividedBy(100);
      const result = allocateNprBuckets(buckets, rate, total);
      const ceilingOf = (i: number) =>
        exact.isZero()
          ? new Dec(0)
          : total.times(buckets[i]!.times(rate)).dividedBy(exact).toDecimalPlaces(2, Dec.ROUND_UP);
      const label = `case ${n}: ${buckets.join('/')} at ${rate.toString()} into ${total.toFixed(2)}`;

      expect(Dec.sum(...result).toFixed(2), label).toBe(total.toFixed(2));
      result.forEach((part, i) => {
        expect(part.isNegative(), label).toBe(false);
        expect(part.decimalPlaces(), label).toBeLessThanOrEqual(2);
        if (buckets[i]!.isZero()) expect(part.isZero(), label).toBe(true);
        const ceiling = ceilingOf(i);
        expect(part.lte(ceiling), label).toBe(true);
      });
      expect(
        allocateNprBuckets(buckets, rate, total).map((x) => x.toFixed(2)),
        label,
      ).toEqual(result.map((x) => x.toFixed(2)));

      // Where the previous split already obeyed the rules, the output is the same to the cent.
      const previous = previousSplit(buckets, rate, total);
      const previousValid = previous.every((part, i) => {
        const ceiling = ceilingOf(i);
        return !part.isNegative() && part.lte(ceiling);
      });
      if (previousValid) {
        compared += 1;
        expect(
          result.map((x) => x.toFixed(2)),
          label,
        ).toEqual(previous.map((x) => x.toFixed(2)));
      }
    }
    expect(compared).toBeGreaterThan(1000);
  });
});
