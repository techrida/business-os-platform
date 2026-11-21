/**
 * The number inputs refuse a space, so a space only reaches a server action from an old tab or a
 * request made without the form. `plainAmount` refuses `10 50` rather than read it as 1050, and
 * the generic "enter an amount" message would not say why, so a refusal names the space.
 */
export const REMOVE_THE_SPACE = 'Remove the space inside the number.';

/** True when a space is the only thing wrong with a number: `10 50` and `1 250.5`, not `2 weeks`. */
export function hasInnerSpace(raw: string): boolean {
  const text = raw.trim();
  return /\S\s+\S/.test(text) && /^[\d,.]+$/.test(text.replace(/\s+/g, ''));
}

/** `REMOVE_THE_SPACE` when the typed text has a space inside it, else the field's own message. */
export function spaceAware(raw: string, generic: string): string {
  return hasInnerSpace(raw) ? REMOVE_THE_SPACE : generic;
}
