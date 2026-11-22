// Splitting a document's frozen NPR total over its VAT register buckets (taxable, VAT, exempt, zero-rated).
// Everything here is unsigned: the caller passes magnitudes and applies a credit note's minus sign to the result, so a
// rounding remainder can never push a bucket across zero.
import { Dec } from '@bos/money-rules';

function scaled(value: Dec, places: number): bigint {
  return BigInt(value.times(new Dec(10).pow(places)).toFixed(0));
}

/**
 * The NPR cents of each bucket, adding up exactly to `nprTotal` (money rule D22: two decimals, half-up, the remainder on
 * the largest bucket).
 *
 * Each bucket starts at its own amount times `rate`, half-up to the cent, and never exceeds its proportional ceiling,
 * `nprTotal * bucket / sum of buckets` rounded up. Cents still missing go to the buckets in order of size, each up to
 * its ceiling; cents too many come off them in the same order, each down to zero. Equal sizes go in bucket order. A
 * bucket with no amount stays exactly zero. When the frozen total is the converted document total, this is the
 * per-bucket rounding with the remainder on the largest bucket.
 *
 * `buckets` and `nprTotal` are non-negative with at most two decimals; `rate` is positive.
 */
export function allocateNprBuckets(buckets: readonly Dec[], rate: Dec, nprTotal: Dec): Dec[] {
  if (buckets.some((b) => b.isNegative() || b.decimalPlaces() > 2))
    throw new RangeError('NPR buckets take non-negative amounts with at most 2 decimals.');
  if (nprTotal.isNegative() || nprTotal.decimalPlaces() > 2)
    throw new RangeError('The NPR total must be non-negative with at most 2 decimals.');
  if (!rate.gt(0)) throw new RangeError('The rate must be positive.');

  const ratePlaces = rate.decimalPlaces();
  const unit = 10n ** BigInt(ratePlaces);
  const rateScaled = scaled(rate, ratePlaces);
  // Each bucket in NPR cents, times `unit` so it stays an exact integer.
  const exact = buckets.map((b) => scaled(b, 2) * rateScaled);
  const sum = exact.reduce((a, b) => a + b, 0n);
  const total = scaled(nprTotal, 2);
  const cents = (values: bigint[]) => values.map((c) => new Dec(c.toString()).dividedBy(100));

  if (sum === 0n) {
    // A total with no bucket to carry it stays on the first bucket, as the register always showed it.
    return cents(buckets.map((_, i) => (i === 0 ? total : 0n)));
  }

  const ceiling = exact.map((e) => (total * e + sum - 1n) / sum);
  const allocated = exact.map((e, i) => {
    const rounded = (2n * e + unit) / (2n * unit);
    return rounded < ceiling[i]! ? rounded : ceiling[i]!;
  });
  const order = exact
    .map((e, i) => ({ e, i }))
    .filter(({ e }) => e > 0n)
    .sort((x, y) => (x.e === y.e ? x.i - y.i : x.e > y.e ? -1 : 1))
    .map(({ i }) => i);

  let remainder = total - allocated.reduce((a, b) => a + b, 0n);
  for (const i of order) {
    if (remainder === 0n) break;
    const room = remainder > 0n ? ceiling[i]! - allocated[i]! : allocated[i]!;
    const magnitude = remainder > 0n ? remainder : -remainder;
    const take = magnitude < room ? magnitude : room;
    const step = remainder > 0n ? take : -take;
    allocated[i] = allocated[i]! + step;
    remainder -= step;
  }
  return cents(allocated);
}
