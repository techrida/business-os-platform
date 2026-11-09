// Credit notes: how much taxable and VAT a credit takes back from an issued invoice, per bucket.
import { Dec, roundMoney } from './money.js';
import { proportionalSlice, sliceAmounts, type SliceAmounts } from './schedule.js';
import type { TaxBucket } from './tax.js';

/**
 * What a credit note takes back:
 * - `lines`: the taxable amount credited on each invoice line, by tax code (VAT follows);
 * - `amount`: an amount including VAT, spread over the invoice in proportion.
 */
export type CreditNoteInput =
  | { kind: 'lines'; lines: readonly { taxCode: string; taxable: Dec }[] }
  | { kind: 'amount'; amount: Dec };

const ZERO = new Dec(0);

/** `part` of `whole`, applied to `value` and rounded half up (0 when `whole` is 0). */
function shareOf(value: Dec, part: Dec, whole: Dec): Dec {
  return whole.isZero() ? ZERO : roundMoney(value.times(part).div(whole));
}

/**
 * The buckets of a credit note against `original` (the issued invoice's buckets).
 *
 * VAT is credited in proportion to the original bucket's VAT, not recomputed at the rate, so
 * crediting a whole bucket returns exactly the VAT that was charged (an invoice that absorbed a
 * schedule remainder may carry VAT a paisa off its rate).
 * - `lines`: per tax code, VAT = original VAT x credited taxable / original taxable, half up.
 *   A code the invoice does not have, or more taxable than the bucket holds, is rejected.
 * - `amount`: from 0 to the invoice total. It is spread over every bucket's taxable and VAT by
 *   largest remainder, so the note's total is the amount exactly.
 *
 * Buckets come back in the invoice's order, one per original bucket; an uncredited bucket is
 * zero. Earlier credit notes on the same invoice are not taken into account.
 */
export function creditNoteSlice(
  original: readonly TaxBucket[],
  credit: CreditNoteInput,
): SliceAmounts {
  if (credit.kind === 'amount') return proportionalSlice(original, credit.amount);

  const credited = new Map<string, Dec>();
  for (const line of credit.lines) {
    if (line.taxable.isNegative()) throw new RangeError('A credited amount must not be negative.');
    if (line.taxable.decimalPlaces() > 2) {
      throw new RangeError('A credited amount has more than 2 decimals.');
    }
    if (!original.some((b) => b.taxCode.code === line.taxCode)) {
      throw new RangeError(`Tax code ${line.taxCode} is not on the invoice.`);
    }
    credited.set(line.taxCode, (credited.get(line.taxCode) ?? ZERO).plus(line.taxable));
  }

  return sliceAmounts(
    original.map((bucket) => {
      const taxable = credited.get(bucket.taxCode.code) ?? ZERO;
      if (taxable.gt(bucket.taxable)) {
        throw new RangeError(
          `Credit of ${taxable.toFixed(2)} on tax code ${bucket.taxCode.code} is more than the ${bucket.taxable.toFixed(2)} invoiced.`,
        );
      }
      return {
        taxCode: bucket.taxCode,
        taxable,
        vat: shareOf(bucket.vat, taxable, bucket.taxable),
        reverseChargeVat: shareOf(bucket.reverseChargeVat, taxable, bucket.taxable),
      };
    }),
  );
}
