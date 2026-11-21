// Typed amounts to the plain digits the contracts take. A string clean-up, never arithmetic.

/** The sentence to show when a comma sits where grouping cannot. */
export const USE_A_POINT = 'Use a point for decimals.';

/** The sentence to show when a space sits inside a number: "10 50" is not 1050. */
export const NO_SPACES = 'Remove the space inside the number.';

const WESTERN = /^[1-9]\d{0,2}(,\d{3})+$/;
const SOUTH_ASIAN = /^[1-9]\d?(,\d{2})*,\d{3}$/;

/**
 * Trims the ends, and drops commas only when they group the whole-number part the Western way (1,250,000) or the
 * South Asian way (12,50,000). Any other comma stays in the result, so the caller's digit check rejects it:
 * "1,5" and "10,50" are decimal commas, and reading them as 15 and 1050 would be a silent 10 to 100 times error.
 * A space inside the number also stays ("10 50", "1 250.5"), so the digit check refuses it too: grouping is typed
 * solid or not at all, and joining the two halves would be the same silent error.
 */
export function plainAmount(raw: string): string {
  const text = raw.trim();
  if (!text.includes(',') || /\s/.test(text)) return text;
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? '' : text.slice(dot);
  if (!whole.includes(',')) return text;
  return WESTERN.test(whole) || SOUTH_ASIAN.test(whole) ? whole.replaceAll(',', '') + rest : text;
}

/** True when the text still holds a comma after grouping was taken out. */
export const hasStrayComma = (raw: string): boolean => plainAmount(raw).includes(',');

/** True when the trimmed text holds a space, tab or other whitespace inside it. */
export const hasInnerSpace = (raw: string): boolean => /\s/.test(raw.trim());
