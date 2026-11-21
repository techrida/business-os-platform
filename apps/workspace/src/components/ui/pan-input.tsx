'use client';

import { DigitBox, type DigitBoxProps, type DigitRules } from './digit-box';

/** A Nepal PAN is exactly this many digits (`VendorPanSchema`). */
export const PAN_DIGITS = 9;

const SEPARATORS = /[\s\p{Pd}]/gu;
const ALL_DIGITS = /^\d*$/;

const PAN_RULES: DigitRules = {
  noun: 'PAN',
  // A stored `123-456-789` is the same PAN as `123456789`; anything else is shown as given.
  parse: (posted) => {
    const bare = posted.replace(SEPARATORS, '');
    return ALL_DIGITS.test(bare) ? bare : posted;
  },
  post: (digits) => digits,
  maxFor: () => PAN_DIGITS,
  cleanPaste: (pasted) => pasted.replace(SEPARATORS, ''),
  tooLong: () => `A PAN is exactly ${PAN_DIGITS} digits.`,
  problem: (digits) => {
    if (digits === '') return null;
    if (!ALL_DIGITS.test(digits)) return `A PAN is ${PAN_DIGITS} digits, with no letters.`;
    if (digits.length === PAN_DIGITS) return null;
    return digits.length > PAN_DIGITS
      ? `A PAN is exactly ${PAN_DIGITS} digits; this has ${digits.length}.`
      : `A PAN is ${PAN_DIGITS} digits; this has ${digits.length}.`;
  },
  count: (digits) => `${digits.length} of ${PAN_DIGITS}`,
};

export type PanInputProps = DigitBoxProps;

/**
 * Nepal PAN: exactly nine digits, typed to its data. Letters and a tenth digit are refused before
 * they go in (announced in a status line), a live "7 of 9" count sits under the box, the phone
 * keypad is numeric, and a paste has its spaces and dashes taken out. A hidden input named `name`
 * posts the digits, so a plain `<form action>` works; `onValueChange` reports the same string.
 *
 *   <Field label="PAN">{(control) => <PanInput {...control} name="pan" required />}</Field>
 */
export function PanInput(props: PanInputProps) {
  return <DigitBox {...props} rules={PAN_RULES} />;
}
