// Typed amounts to the plain digits the contracts take. A string clean-up, never arithmetic.

/** The sentence to show when a comma sits where grouping cannot. */
export const USE_A_POINT = 'Use a point for decimals.';

const WESTERN = /^[1-9]\d{0,2}(,\d{3})+$/;
const SOUTH_ASIAN = /^[1-9]\d?(,\d{2})*,\d{3}$/;

/**
 * Drops spaces, and drops commas only when they group the whole-number part the Western way (1,250,000) or the
 * South Asian way (12,50,000). Any other comma stays in the result, so the caller's digit check rejects it:
 * "1,5" and "10,50" are decimal commas, and reading them as 15 and 1050 would be a silent 10 to 100 times error.
 */
export function plainAmount(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed.includes(',')) return trimmed.replace(/\s/g, '');
  // Grouping is typed solid: a space inside a comma-grouped number ("10,50 0") is not grouping, so it stays and is refused.
  const text = trimmed;
  if (/\s/.test(text)) return text;
  const dot = text.indexOf('.');
  const whole = dot === -1 ? text : text.slice(0, dot);
  const rest = dot === -1 ? '' : text.slice(dot);
  if (!whole.includes(',')) return text;
  return WESTERN.test(whole) || SOUTH_ASIAN.test(whole) ? whole.replaceAll(',', '') + rest : text;
}

/** True when the text still holds a comma after grouping was taken out. */
export const hasStrayComma = (raw: string): boolean => plainAmount(raw).includes(',');
