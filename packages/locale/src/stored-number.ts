import { Dec } from './money.js';

/**
 * A stored decimal as the text an editor starts from, so the box shows and posts the same number without the
 * column's extra zeros: `100000.000` is `100000`, or `100000.00` with `scale` 2. Digits that are not zeros are never
 * dropped: a value with more real decimals than `scale` stays as it came, so the box flags it instead of rounding.
 * Anything that is not a plain non-negative decimal also stays as it came.
 */
export function storedNumberText(stored: string, scale?: number): string {
  if (!/^\d+(\.\d+)?$/.test(stored)) return stored;
  const value = new Dec(stored);
  if (scale === undefined) return value.toFixed();
  return value.decimalPlaces() <= scale ? value.toFixed(scale) : stored;
}
