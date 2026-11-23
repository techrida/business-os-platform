'use client';

import { DigitBox, type DigitBoxProps, type DigitRules } from './digit-box';

/** A Nepal PAN is exactly this many digits (`VendorPanSchema`). */
export const PAN_DIGITS = 9;

const SEPARATORS = /[\s\p{Pd}]/gu;
const ALL_DIGITS = /^\d*$/;

const PAN_RULES: DigitRules = {
  noun: 'PAN',
  // A stored value is shown exactly as stored, so an edit of some other field never rewrites it. One
  // the box cannot hold (`123-456-789`) is flagged and repaired by editing.
  parse: (posted) => posted,
  post: (digits) => digits,
  maxFor: () => PAN_DIGITS,
  cleanPaste: (pasted) => pasted.replace(SEPARATORS, ''),
  tooLong: () => `A PAN is exactly ${PAN_DIGITS} digits.`,
  problem: (digits) => {
    if (digits === '') return null;
    if (!ALL_DIGITS.test(digits))
      return `A PAN is ${PAN_DIGITS} digits, with no letters, spaces or dashes.`;
    if (digits.length === PAN_DIGITS) return null;
    return digits.length > PAN_DIGITS
      ? `A PAN is exactly ${PAN_DIGITS} digits; this has ${digits.length}.`
      : `A PAN is ${PAN_DIGITS} digits; this has ${digits.length}.`;
  },
};

export type PanInputProps = DigitBoxProps;

/**
 * Nepal PAN: exactly nine digits, typed to its data. Letters and a tenth digit are refused before
 * they go in (announced in a status line), no counter (UIP-FORM-008), the phone
 * keypad is numeric, and a paste has its spaces and dashes taken out. A hidden input named `name`
 * posts the digits, so a plain `<form action>` works; `onValueChange` reports the same string.
 *
 *   <Field label="PAN">{(control) => <PanInput {...control} name="pan" required />}</Field>
 */
export function PanInput(props: PanInputProps) {
  return <DigitBox {...props} rules={PAN_RULES} />;
}
