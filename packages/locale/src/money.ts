// Money for Business OS: exact decimal arithmetic and Nepali-style display (NFR: correctness, no float drift).
// Why decimal.js: JS numbers cannot hold 0.1 + 0.2 exactly, and amounts live in numeric(18,2) in Postgres.
import { Decimal } from 'decimal.js';
import type { NumberSystem } from './number-words.js';

/** The one Decimal every package uses: 34 significant digits (IEEE decimal128) and half-up rounding (accounting convention). */
export const Dec = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export type Currency = 'NPR' | 'INR' | 'USD';

/** Lakh/crore grouping unless a setting says otherwise (Nepal is the home market). */
export const DEFAULT_NUMBER_SYSTEM: NumberSystem = 'south_asian';

const SYMBOLS: Record<Currency, string> = { NPR: 'रू', INR: '₹', USD: '$' };

// NPR and INR use lakh/crore grouping (12,50,000). USD uses western grouping (1,250,000) because that is how USD is written.
const grouper = (cur: Currency): Intl.NumberFormat =>
  new Intl.NumberFormat(cur === 'USD' ? 'en-US' : 'en-IN');
const groupers = new Map<Currency, Intl.NumberFormat>();

/**
 * Groups the digits of a non-negative integer string: south_asian `20,18,180` (3 then 2s), international `2,018,180`.
 * Works on the string, so it is exact for any length.
 */
export function groupDigits(intPart: string, system: NumberSystem): string {
  if (!/^\d+$/.test(intPart)) throw new RangeError(`Not a digit string: ${intPart}`);
  if (system === 'international') return intPart.replace(/\B(?=(\d{3})+$)/g, ',');
  return intPart.replace(/\B(?=(\d{2})*\d{3}$)/g, ',');
}

/**
 * Formats a decimal string for display, e.g. `NPR 12,50,000.00`.
 * Takes a string (never a number) so no precision is lost before we round to 2 places, half up.
 * The integer part goes through BigInt, so it stays exact above 2^53.
 * `numberSystem` picks the grouping for every currency; left out, NPR/INR use lakh grouping and USD western.
 */
export function formatMoney(
  amount: string,
  currency: Currency,
  opts?: { symbol?: boolean; numberSystem?: NumberSystem },
): string {
  const value = new Dec(amount);
  if (!value.isFinite()) throw new RangeError(`Not a finite decimal: ${amount}`);

  const fixed = value.toDecimalPlaces(2).toFixed(2);
  const negative = fixed.startsWith('-');
  const [intPart = '0', fraction = '00'] = (negative ? fixed.slice(1) : fixed).split('.');

  let groupedInt: string;
  if (opts?.numberSystem) {
    groupedInt = groupDigits(intPart, opts.numberSystem);
  } else {
    let fmt = groupers.get(currency);
    if (!fmt) {
      fmt = grouper(currency);
      groupers.set(currency, fmt);
    }
    groupedInt = fmt.format(BigInt(intPart));
  }
  const body = `${groupedInt}.${fraction}`;

  // "-0.00" must display as "0.00": a rounded-away negative is not a negative amount.
  const isNegative = negative && !(BigInt(intPart) === 0n && fraction === '00');
  const sign = isNegative ? '-' : '';
  // Symbol form hugs the sign ("-₹1.00"); code form reads "NPR -1.00".
  return opts?.symbol ? `${sign}${SYMBOLS[currency]}${body}` : `${currency} ${sign}${body}`;
}

/** Round a milestone's share half up to the currency's two minor-unit digits. */
export function roundPaymentShare(total: Dec, percent: Decimal.Value): Dec {
  return total.times(percent).div(100).toDecimalPlaces(2);
}

/** Split a two-decimal total across a complete schedule, assigning the remainder to its last row. */
export function allocatePaymentSchedule(total: Dec, percents: readonly Decimal.Value[]): Dec[] {
  let remaining = total;
  return percents.map((percent, index) => {
    if (index === percents.length - 1) return remaining;
    // On tiny totals, several half-up shares can exhaust the balance before the final row.
    const amount = Dec.min(roundPaymentShare(total, percent), remaining);
    remaining = remaining.minus(amount);
    return amount;
  });
}
