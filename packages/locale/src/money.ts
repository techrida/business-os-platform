// Money for Business OS: exact decimal arithmetic and Nepali-style display (NFR: correctness, no float drift).
// Why decimal.js: JS numbers cannot hold 0.1 + 0.2 exactly, and amounts live in numeric(18,2) in Postgres.
import { Decimal } from 'decimal.js';

/** The one Decimal every package uses: 34 significant digits (IEEE decimal128) and half-up rounding (accounting convention). */
export const Dec = Decimal.clone({ precision: 34, rounding: Decimal.ROUND_HALF_UP });
export type Dec = InstanceType<typeof Dec>;

export type Currency = 'NPR' | 'INR' | 'USD';

const SYMBOLS: Record<Currency, string> = { NPR: 'रू', INR: '₹', USD: '$' };

// NPR and INR use lakh/crore grouping (12,50,000). USD uses western grouping (1,250,000) because that is how USD is written.
const grouper = (cur: Currency): Intl.NumberFormat =>
  new Intl.NumberFormat(cur === 'USD' ? 'en-US' : 'en-IN');
const groupers = new Map<Currency, Intl.NumberFormat>();

/**
 * Formats a decimal string for display, e.g. `NPR 12,50,000.00`.
 * Takes a string (never a number) so no precision is lost before we round to 2 places, half up.
 * The integer part goes through BigInt, so it stays exact above 2^53.
 */
export function formatMoney(
  amount: string,
  currency: Currency,
  opts?: { symbol?: boolean },
): string {
  const value = new Dec(amount);
  if (!value.isFinite()) throw new RangeError(`Not a finite decimal: ${amount}`);

  const fixed = value.toDecimalPlaces(2).toFixed(2);
  const negative = fixed.startsWith('-');
  const [intPart = '0', fraction = '00'] = (negative ? fixed.slice(1) : fixed).split('.');

  let fmt = groupers.get(currency);
  if (!fmt) {
    fmt = grouper(currency);
    groupers.set(currency, fmt);
  }
  const body = `${fmt.format(BigInt(intPart))}.${fraction}`;

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
