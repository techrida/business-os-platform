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

/**
 * The amount as a hydrated number input posts it: `1250.00` is `1250`, `1250.` is `1250`, `0.00` is `0`. A form posted
 * before hydration carries the padded text, and a retry under the same idempotency key must not change body. Plain
 * digits in (see `plainAmount`); anything else comes back unchanged for the caller's digit check to refuse.
 */
export function canonicalAmount(plain: string): string {
  if (!/^(\d+(\.\d*)?|\.\d+)$/.test(plain)) return plain;
  // The hydrated box also drops leading zeros (`0500` is `500`) and writes `.5` as `0.5`.
  const [whole = '', fraction = ''] = plain.split('.');
  const digits = whole.replace(/^0+(?=\d)/, '') || '0';
  const kept = fraction.replace(/0+$/, '');
  return kept === '' ? digits : `${digits}.${kept}`;
}

/** `plainAmount` then `canonicalAmount`: the text a server action puts in its request body for a typed amount. */
export const postedAmount = (raw: string): string => canonicalAmount(plainAmount(raw));
