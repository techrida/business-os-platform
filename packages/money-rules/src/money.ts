// Money type and rounding. Strings (or Dec) in and out; a JS number never carries money.
import { Dec } from '@bos/locale';

// One Decimal for the whole package: @bos/locale's clone (34 digits, ROUND_HALF_UP), so a
// formatted amount and a priced amount are rounded by the same rule (ADR 0024).
export { Dec, formatMoney } from '@bos/locale';
export type { Currency } from '@bos/locale';

const PLAIN_DECIMAL = /^-?\d+(\.\d+)?$/;

/** Decimal places of an exact decimal (0 for an integer). */
export function decimalPlaces(value: Dec): number {
  return value.decimalPlaces();
}

/**
 * Parses a plain decimal string ("1880000.00", "-3", "0.0001"). Rejects numbers, exponents,
 * thousands separators, blanks and anything else a float round-trip could have produced.
 */
export function parseDecimal(text: string): Dec {
  if (typeof text !== 'string') {
    throw new TypeError('Money values must be decimal strings, never JS numbers.');
  }
  const trimmed = text.trim();
  if (!PLAIN_DECIMAL.test(trimmed)) {
    throw new RangeError(`Not a plain decimal: ${JSON.stringify(text)}`);
  }
  return new Dec(trimmed);
}

/** Rounds to 2 decimal places, half up (a tie moves away from zero). */
export function roundMoney(value: Dec): Dec {
  return value.toDecimalPlaces(2, Dec.ROUND_HALF_UP);
}

/** Parses a decimal string and rounds it to 2dp half up. */
export function parseMoney(text: string): Dec {
  return roundMoney(parseDecimal(text));
}

/** The numeric(18,2) text for an amount: always 2 decimals, never "-0.00". */
export function moneyToString(value: Dec): string {
  const fixed = roundMoney(value).toFixed(2);
  return fixed === '-0.00' ? '0.00' : fixed;
}

/** A quantity, numeric(18,4): greater than zero, at most 4 decimals (no silent rounding). */
export function parseQuantity(text: string): Dec {
  const value = parseDecimal(text);
  if (decimalPlaces(value) > 4) throw new RangeError(`Quantity has more than 4 decimals: ${text}`);
  if (!value.gt(0)) throw new RangeError(`Quantity must be greater than zero: ${text}`);
  return value;
}

/** An FX rate, numeric(18,6): greater than zero, at most 6 decimals. */
export function parseFxRate(text: string): Dec {
  const value = parseDecimal(text);
  if (decimalPlaces(value) > 6) throw new RangeError(`FX rate has more than 6 decimals: ${text}`);
  if (!value.gt(0)) throw new RangeError(`FX rate must be greater than zero: ${text}`);
  return value;
}
