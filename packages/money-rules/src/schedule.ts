// Billing schedule (P3 A7) and invoice slices of a sales order (P3 architect §3.5 step 7).
import { allocatePaymentSchedule } from '@bos/locale';

import { allocateLargestRemainder } from './allocate.js';
import { Dec, roundMoney } from './money.js';
import type { TaxBucket } from './tax.js';

/** Tax buckets of one invoice (or credit note) cut from a priced document, with its totals. */
export interface SliceAmounts {
  /** One bucket per source bucket, in the source order (a bucket may be all zero). */
  buckets: TaxBucket[];
  taxableTotal: Dec;
  vatTotal: Dec;
  /** taxableTotal + vatTotal. Reverse-charge VAT is not part of it. */
  total: Dec;
}

const ZERO = new Dec(0);
const HUNDRED = new Dec(100);

function assertAmount(value: Dec, label: string): void {
  if (value.isNegative()) throw new RangeError(`${label} must not be negative.`);
  if (value.decimalPlaces() > 2) throw new RangeError(`${label} has more than 2 decimals.`);
}

/** Wraps buckets with their totals. */
export function sliceAmounts(buckets: TaxBucket[]): SliceAmounts {
  const taxableTotal = buckets.reduce((sum, b) => sum.plus(b.taxable), ZERO);
  const vatTotal = buckets.reduce((sum, b) => sum.plus(b.vat), ZERO);
  return { buckets, taxableTotal, vatTotal, total: taxableTotal.plus(vatTotal) };
}

/**
 * Splits `amount` over the components (taxable, then VAT) of every bucket by largest remainder,
 * so the slice adds up to `amount` exactly and each component is within a paisa of its exact
 * share. No component gets more than it holds, because no exact share exceeds it. Reverse-charge
 * VAT is outside the total; it follows its bucket's taxable share, rounded half up.
 * `amount` must be from 0 to the buckets' total (taxable + VAT).
 */
export function proportionalSlice(buckets: readonly TaxBucket[], amount: Dec): SliceAmounts {
  assertAmount(amount, 'The slice amount');
  const available = sliceAmounts([...buckets]).total;
  if (amount.gt(available)) {
    throw new RangeError(
      `The slice amount ${amount.toFixed(2)} is more than the ${available.toFixed(2)} available.`,
    );
  }
  const shares = allocateLargestRemainder(
    amount,
    buckets.flatMap((b) => [b.taxable, b.vat]),
  );
  return sliceAmounts(
    buckets.map((bucket, i) => {
      const taxable = shares[2 * i]!;
      const reverseChargeVat = bucket.taxable.isZero()
        ? ZERO
        : roundMoney(bucket.reverseChargeVat.times(taxable).div(bucket.taxable));
      return { taxCode: bucket.taxCode, taxable, vat: shares[2 * i + 1]!, reverseChargeVat };
    }),
  );
}

/**
 * Splits a sales order total over its billing schedule (A7: 60/20/20 by default). The percents
 * may have any decimals but must not be negative and must add up to exactly 100. Each part is a
 * whole paisa and the parts add up to `total` exactly. Each share rounds half up, then the last line takes the remaining amount.
 */
export function splitSchedule(total: Dec, percents: readonly Dec[]): Dec[] {
  assertAmount(total, 'The schedule total');
  if (percents.length === 0) throw new RangeError('A schedule needs at least one line.');
  if (percents.some((p) => p.isNegative())) {
    throw new RangeError('A schedule percent must not be negative.');
  }
  const percentSum = percents.reduce((sum, p) => sum.plus(p), ZERO);
  if (!percentSum.eq(HUNDRED)) {
    throw new RangeError(`Schedule percents add up to ${percentSum.toString()}, not 100.`);
  }
  return allocatePaymentSchedule(total, percents);
}

/**
 * Cuts one invoice from a sales order's tax buckets.
 *
 * - `soBuckets`: the priced SO's buckets (`PricedDoc.buckets`).
 * - `sliceTotal`: the schedule line's amount, VAT included (from `splitSchedule`).
 * - `billedSoFar`: every bucket of every slice already issued, in any order; buckets with the
 *   same tax code are added together. A code the SO does not have is rejected.
 * - `isLast`: true for the last slice issued (not necessarily the last schedule line).
 *
 * A slice that is not the last scales what is still unbilled in each bucket so its total is
 * `sliceTotal` exactly (see `proportionalSlice`). Its VAT is the bucket's VAT share, which can
 * differ from 13% of its taxable by a paisa. The last slice absorbs the remainder: each of its
 * components is the SO's minus everything billed, and `sliceTotal` is not used. So the slices of
 * an SO add up to its buckets exactly, whatever order they are issued in.
 */
export function invoiceSlice(
  soBuckets: readonly TaxBucket[],
  sliceTotal: Dec,
  billedSoFar: readonly TaxBucket[],
  isLast: boolean,
): SliceAmounts {
  const soCodes = new Set(soBuckets.map((b) => b.taxCode.code));
  const billed = new Map<string, { taxable: Dec; vat: Dec; reverseChargeVat: Dec }>();
  for (const bucket of billedSoFar) {
    const code = bucket.taxCode.code;
    if (!soCodes.has(code)) {
      throw new RangeError(`Billed tax code ${code} is not on the sales order.`);
    }
    const sum = billed.get(code) ?? { taxable: ZERO, vat: ZERO, reverseChargeVat: ZERO };
    billed.set(code, {
      taxable: sum.taxable.plus(bucket.taxable),
      vat: sum.vat.plus(bucket.vat),
      reverseChargeVat: sum.reverseChargeVat.plus(bucket.reverseChargeVat),
    });
  }

  const unbilled: TaxBucket[] = soBuckets.map((bucket) => {
    const done = billed.get(bucket.taxCode.code);
    const rest: TaxBucket = {
      taxCode: bucket.taxCode,
      taxable: bucket.taxable.minus(done?.taxable ?? ZERO),
      vat: bucket.vat.minus(done?.vat ?? ZERO),
      reverseChargeVat: bucket.reverseChargeVat.minus(done?.reverseChargeVat ?? ZERO),
    };
    if (rest.taxable.isNegative() || rest.vat.isNegative() || rest.reverseChargeVat.isNegative()) {
      throw new RangeError(`Tax code ${bucket.taxCode.code} is billed beyond the sales order.`);
    }
    return rest;
  });

  return isLast ? sliceAmounts(unbilled) : proportionalSlice(unbilled, sliceTotal);
}
