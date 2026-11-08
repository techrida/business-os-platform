// Effective discount percentage and the approval trigger. The rule is strict "> 12" on the
// unrounded percentage; the 4-decimal text is for storage and display only.
import { Dec, parseDecimal } from './money.js';

const HUNDRED = new Dec(100);

/** Discounts strictly above this percentage add the Management approval step. */
export const DISCOUNT_APPROVAL_THRESHOLD_PCT = '12';

function assertDiscountWithinSubtotal(discount: Dec, subtotal: Dec): void {
  if (discount.isNegative() || subtotal.isNegative()) {
    throw new RangeError('A discount and a subtotal must not be negative.');
  }
  if (discount.gt(subtotal)) throw new RangeError('A discount cannot exceed the subtotal.');
}

/**
 * Effective discount % = discount / subtotal x 100, as numeric(9,4) text (half up). Display and
 * storage only: never compare this text with the threshold, use `exceedsDiscountThreshold`.
 */
export function effectiveDiscountPct(discount: Dec, subtotal: Dec): string {
  assertDiscountWithinSubtotal(discount, subtotal);
  if (subtotal.isZero()) return '0.0000';
  return discount.times(HUNDRED).div(subtotal).toDecimalPlaces(4, Dec.ROUND_HALF_UP).toFixed(4);
}

/**
 * True when discount / subtotal x 100 is strictly greater than `thresholdPct`. Decided exactly
 * as `discount x 100 > threshold x subtotal`: no division, no rounding, so a ratio that stores
 * as "12.0000" but is really 12.00001% still triggers.
 */
export function exceedsDiscountThreshold(
  discount: Dec,
  subtotal: Dec,
  thresholdPct: string = DISCOUNT_APPROVAL_THRESHOLD_PCT,
): boolean {
  assertDiscountWithinSubtotal(discount, subtotal);
  if (subtotal.isZero()) return false;
  const threshold = parseDecimal(thresholdPct);
  return discount.times(HUNDRED).gt(threshold.times(subtotal));
}
