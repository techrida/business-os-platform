// Amounts in words for printed documents (cheque-style "Twenty Lakh Eighteen Thousand ... Rupees Only").
// Pure and BigInt-based: no float is ever involved, and the integer part stays exact above 2^53.
import { Dec, type Currency } from './money.js';

/** How a number is grouped and named: lakh/crore (Nepal, India) or thousand/million/billion. */
export type NumberSystem = 'south_asian' | 'international';

export const NUMBER_SYSTEMS: readonly NumberSystem[] = ['south_asian', 'international'];

interface ScaleUnit {
  /** Power of ten at which the unit starts. */
  readonly exponent: number;
  readonly name: string;
}

// Ascending. South Asian steps are two digits wide after thousand (lakh 10^5, crore 10^7, arab 10^9, ...).
// The top unit takes any multiplier, spelled recursively ("One Hundred Twenty Three Shankh"), so any size is exact.
// Beyond crore the names follow the Nepali/Hindi series: arab, kharab, neel, padma, shankh.
const SCALES: Record<NumberSystem, readonly (ScaleUnit & { readonly value: bigint })[]> = {
  south_asian: withValues([
    { exponent: 3, name: 'Thousand' },
    { exponent: 5, name: 'Lakh' },
    { exponent: 7, name: 'Crore' },
    { exponent: 9, name: 'Arab' },
    { exponent: 11, name: 'Kharab' },
    { exponent: 13, name: 'Neel' },
    { exponent: 15, name: 'Padma' },
    { exponent: 17, name: 'Shankh' },
  ]),
  international: withValues([
    { exponent: 3, name: 'Thousand' },
    { exponent: 6, name: 'Million' },
    { exponent: 9, name: 'Billion' },
    { exponent: 12, name: 'Trillion' },
    { exponent: 15, name: 'Quadrillion' },
    { exponent: 18, name: 'Quintillion' },
  ]),
};

function withValues(
  units: readonly ScaleUnit[],
): readonly (ScaleUnit & { readonly value: bigint })[] {
  return units.map((unit) => ({ ...unit, value: 10n ** BigInt(unit.exponent) }));
}

const ONES = [
  '',
  'One',
  'Two',
  'Three',
  'Four',
  'Five',
  'Six',
  'Seven',
  'Eight',
  'Nine',
  'Ten',
  'Eleven',
  'Twelve',
  'Thirteen',
  'Fourteen',
  'Fifteen',
  'Sixteen',
  'Seventeen',
  'Eighteen',
  'Nineteen',
] as const;
const TENS = [
  '',
  '',
  'Twenty',
  'Thirty',
  'Forty',
  'Fifty',
  'Sixty',
  'Seventy',
  'Eighty',
  'Ninety',
] as const;

/** 1..999 in Title Case words, no hyphens and no "and" ("One Hundred Twenty One"). */
function spellBelowThousand(n: number): string {
  const words: string[] = [];
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (hundreds > 0) words.push(ONES[hundreds] ?? '', 'Hundred');
  if (rest > 0 && rest < 20) {
    words.push(ONES[rest] ?? '');
  } else if (rest >= 20) {
    words.push(TENS[Math.floor(rest / 10)] ?? '');
    if (rest % 10 > 0) words.push(ONES[rest % 10] ?? '');
  }
  return words.join(' ');
}

/** Words for a non-negative integer; the empty string for zero. */
function spell(n: bigint, system: NumberSystem): string {
  if (n === 0n) return '';
  const scales = SCALES[system];
  for (let i = scales.length - 1; i >= 0; i -= 1) {
    const unit = scales[i];
    if (unit && n >= unit.value) {
      return [spell(n / unit.value, system), unit.name, spell(n % unit.value, system)]
        .filter((part) => part !== '')
        .join(' ');
    }
  }
  return spellBelowThousand(Number(n));
}

interface CurrencyWords {
  readonly major: readonly [singular: string, plural: string];
  readonly minor: readonly [singular: string, plural: string];
}

const CURRENCY_WORDS: Record<Currency, CurrencyWords> = {
  NPR: { major: ['Rupee', 'Rupees'], minor: ['Paisa', 'Paisa'] },
  INR: { major: ['Rupee', 'Rupees'], minor: ['Paisa', 'Paisa'] },
  USD: { major: ['Dollar', 'Dollars'], minor: ['Cent', 'Cents'] },
};

/**
 * Spells an amount for a printed document, e.g. `Twenty Lakh Eighteen Thousand One Hundred Eighty Rupees Only`.
 * The amount is a decimal string, rounded half up to 2 places (D22) before spelling, so 999999.995 rolls into the next unit.
 * Zero rupees are omitted when there is a paisa part ("Fifty Paisa Only"); negatives start with "Minus".
 */
export function amountInWords(amount: string, currency: Currency, system: NumberSystem): string {
  const value = new Dec(amount);
  if (!value.isFinite()) throw new RangeError(`Not a finite decimal: ${amount}`);

  const fixed = value.toDecimalPlaces(2).toFixed(2);
  const negative = fixed.startsWith('-');
  const [intPart = '0', fraction = '00'] = (negative ? fixed.slice(1) : fixed).split('.');
  const major = BigInt(intPart);
  const minor = Number(fraction);

  const names = CURRENCY_WORDS[currency];
  const parts: string[] = [];
  if (major > 0n || minor === 0) {
    parts.push(
      `${major === 0n ? 'Zero' : spell(major, system)} ${names.major[major === 1n ? 0 : 1]}`,
    );
  }
  if (minor > 0) {
    const minorWords = `${spellBelowThousand(minor)} ${names.minor[minor === 1 ? 0 : 1]}`;
    parts.push(major > 0n ? `And ${minorWords}` : minorWords);
  }
  // A rounded-away negative ("-0.004") is zero, not "Minus Zero".
  const sign = negative && (major > 0n || minor > 0) ? 'Minus ' : '';
  return `${sign}${parts.join(' ')} Only`;
}
