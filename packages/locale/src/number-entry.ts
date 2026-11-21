// The rules behind a number input, with no React and no DOM: what a paste becomes, and whether a plain decimal
// string fits its digit limits and bounds. The input components call these; so can any test.
import { Dec } from './money.js';
import { NO_SPACES, USE_A_POINT, plainAmount } from './plain-amount.js';

/** Whole digits and decimals a field takes. Same shape as the contracts' `NumberLimits`, which build the patterns. */
export interface NumberLimits {
  readonly intDigits: number;
  readonly scale: number;
}

/** Plain decimal strings, compared exactly with `Dec`; never numbers. */
export interface NumberBounds {
  readonly min?: string | undefined;
  readonly max?: string | undefined;
}

export type NumberRefusal =
  | 'empty'
  | 'not_a_number'
  | 'comma'
  | 'space'
  | 'too_many_digits'
  | 'too_many_decimals'
  | 'below_min'
  | 'above_max';

export type NumberCheck =
  | { readonly ok: true; readonly value: string }
  | { readonly ok: false; readonly reason: NumberRefusal; readonly message: string };

/** The sentence for each refusal. The bounds are named by the caller, who knows the currency and unit. */
export function refusalMessage(
  reason: NumberRefusal,
  limits: NumberLimits,
  bounds?: NumberBounds,
): string {
  switch (reason) {
    case 'empty':
      return 'Enter a number.';
    case 'not_a_number':
      return 'Use digits and a point only.';
    case 'comma':
      return USE_A_POINT;
    case 'space':
      return NO_SPACES;
    case 'too_many_digits':
      return `At most ${limits.intDigits} digits before the point.`;
    case 'too_many_decimals':
      return limits.scale === 0
        ? 'Whole numbers only.'
        : `At most ${limits.scale} decimal${limits.scale === 1 ? '' : 's'}.`;
    case 'below_min':
      return `At least ${bounds?.min ?? ''}`.trim();
    case 'above_max':
      return `At most ${bounds?.max ?? ''}`.trim();
  }
}

const refuse = (
  reason: NumberRefusal,
  limits: NumberLimits,
  bounds?: NumberBounds,
): NumberCheck => ({ ok: false, reason, message: refusalMessage(reason, limits, bounds) });

/** `1250.5`, `.5`, `12.` and `` split into whole and decimal digits; anything else is null. */
function splitDecimal(text: string): { whole: string; fraction: string; hasPoint: boolean } | null {
  const match = /^(\d*)(\.(\d*))?$/.exec(text);
  if (!match) return null;
  return { whole: match[1] ?? '', fraction: match[3] ?? '', hasPoint: match[2] !== undefined };
}

/**
 * True when `text` could still become a valid entry by typing more: digits with at most one point, inside the
 * digit limits. The empty string and a bare point count. Used per keystroke, so it never compares to min or max.
 */
export function fitsWhileTyping(text: string, limits: NumberLimits): boolean {
  const parts = splitDecimal(text);
  if (!parts) return false;
  if (parts.whole.replace(/^0+(?=\d)/, '').length > limits.intDigits) return false;
  if (parts.hasPoint && limits.scale === 0) return false;
  return parts.fraction.length <= limits.scale;
}

/**
 * Whether a finished plain decimal string fits the field: digits and an optional point, within the limits and the
 * bounds. Returns the value normalised (`007` is `7`, `.5` is `0.5`, a bare trailing point is dropped).
 * `min` and `max` are compared with `Dec`, so 16-digit amounts stay exact.
 */
export function withinLimits(
  plain: string,
  limits: NumberLimits,
  bounds?: NumberBounds,
): NumberCheck {
  if (plain === '') return refuse('empty', limits, bounds);
  const parts = splitDecimal(plain);
  if (!parts || (parts.whole === '' && parts.fraction === '')) {
    return refuse('not_a_number', limits, bounds);
  }
  const whole = parts.whole.replace(/^0+(?=\d)/, '') || '0';
  if (whole.length > limits.intDigits) return refuse('too_many_digits', limits, bounds);
  if (parts.fraction.length > limits.scale) return refuse('too_many_decimals', limits, bounds);
  const value = parts.fraction === '' ? whole : `${whole}.${parts.fraction}`;
  const number = new Dec(value);
  if (bounds?.min !== undefined && bounds.min !== '' && number.lt(new Dec(bounds.min))) {
    return refuse('below_min', limits, bounds);
  }
  if (bounds?.max !== undefined && bounds.max !== '' && number.gt(new Dec(bounds.max))) {
    return refuse('above_max', limits, bounds);
  }
  return { ok: true, value };
}

// One leading currency marker, with the space after it, and the trailing "/-" accountants write after a whole amount.
const LEADING_MARKER = /^(?:NPR|INR|USD|Rs\.?|रू|₹|\$)\s*/i;
const TRAILING_DASH = /\s*\/-$/;

/**
 * What a paste becomes. Trims, drops one leading currency marker (`NPR`, `Rs.`, `रू`, `INR`, `₹`, `USD`, `$`) and a
 * trailing `/-`, refuses any space left inside, lets `plainAmount` take out valid lakh or western grouping, then
 * checks the digit limits and bounds. A decimal comma, a second point, a sign or a letter is refused with the
 * reason, never guessed at: `1,5` is not 15 and `10 50` is not 1050.
 */
export function normalisePastedNumber(
  text: string,
  limits: NumberLimits,
  bounds?: NumberBounds,
): NumberCheck {
  const cleaned = text.trim().replace(LEADING_MARKER, '').replace(TRAILING_DASH, '').trim();
  if (cleaned === '') return refuse('empty', limits, bounds);
  if (/\s/.test(cleaned)) return refuse('space', limits, bounds);
  const plain = plainAmount(cleaned);
  if (plain.includes(',')) return refuse('comma', limits, bounds);
  return withinLimits(plain, limits, bounds);
}
