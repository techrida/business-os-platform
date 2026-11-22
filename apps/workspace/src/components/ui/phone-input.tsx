'use client';

import { useLayoutEffect, useRef, useState } from 'react';

import { DigitBox, type DigitBoxProps, type DigitRules } from './digit-box';
import styles from './digit-box.module.css';

/** Nepal's country code, shown as the fixed prefix of the default box. */
export const NEPAL_PREFIX = '+977';

const NOISE = /[\s\p{Pd}().]/gu;
const ALL_DIGITS = /^\d*$/;

/** A Nepal mobile number starts with 9 and has ten digits. */
const MOBILE_DIGITS = 10;
/**
 * A Nepal landline is the area code without its trunk 0, then the subscriber number: 8 digits in
 * practice (`1 4123456`, `61 523456`). The contract bounds only the whole E.164 number (7 to 15
 * digits), so the box accepts 7 to 9 national digits rather than guess one length.
 */
const LANDLINE_MIN = 7;
const LANDLINE_MAX = 9;
/** E.164: at most 15 digits in all, at least 7 (`PhoneSchema`). */
const E164_MIN = 7;
const E164_MAX = 15;

const isMobile = (digits: string) => digits.startsWith('9');

const LEADING_ZERO = `Leave out the leading 0. ${NEPAL_PREFIX} is already there.`;
const CODE_ZERO = 'A country code does not start with 0.';

/** FX8's Nepal box: `+977` is a fixed prefix; a mobile is ten digits starting with 9, a landline 7 to 9. */
export const NEPAL_RULES: DigitRules = {
  noun: 'phone number',
  // The stored form is E.164, `+9779812345678`. Anything else is shown as given and flagged.
  parse: (posted) => {
    if (!posted.startsWith(NEPAL_PREFIX)) return posted;
    const national = posted.slice(NEPAL_PREFIX.length).replace(NOISE, '');
    return ALL_DIGITS.test(national) ? national : posted;
  },
  post: (digits) => (digits === '' ? '' : `${NEPAL_PREFIX}${digits}`),
  maxFor: (digits) => (isMobile(digits) ? MOBILE_DIGITS : LANDLINE_MAX),
  cleanPaste: (pasted, whole) => {
    let bare = pasted.replace(NOISE, '');
    // A country code or trunk 0 is only dropped from a whole number; pasted into part of one, the
    // digits are the user's own.
    if (!whole) return bare;
    if (bare.startsWith('+977')) bare = bare.slice(4);
    else if (bare.startsWith('00977')) bare = bare.slice(5);
    else if (bare.startsWith('977') && bare.length > MOBILE_DIGITS) bare = bare.slice(3);
    // `01 4123456`: the trunk 0 is not part of the E.164 number.
    return bare.startsWith('0') ? bare.slice(1) : bare;
  },
  refuseDigits: (digits) => (digits.startsWith('0') ? LEADING_ZERO : null),
  tooLong: (digits) =>
    isMobile(digits)
      ? `A mobile number has ${MOBILE_DIGITS} digits.`
      : `A landline number has ${LANDLINE_MIN} to ${LANDLINE_MAX} digits.`,
  problem: (digits) => {
    if (digits === '') return null;
    if (!ALL_DIGITS.test(digits)) {
      return `Start with ${NEPAL_PREFIX} and type digits only, for example ${NEPAL_PREFIX}9812345678.`;
    }
    // Deleting the first digit can leave a 0 in front; it is refused when typed and flagged here.
    if (digits.startsWith('0')) return LEADING_ZERO;
    if (isMobile(digits)) {
      return digits.length === MOBILE_DIGITS
        ? null
        : `A mobile number has ${MOBILE_DIGITS} digits; this has ${digits.length}.`;
    }
    return digits.length >= LANDLINE_MIN
      ? null
      : `A landline number has ${LANDLINE_MIN} to ${LANDLINE_MAX} digits; this has ${digits.length}.`;
  },
  count: (digits) => {
    if (digits === '') return `Mobile: ${MOBILE_DIGITS} digits, starting with 9`;
    return isMobile(digits)
      ? `${digits.length} of ${MOBILE_DIGITS} (mobile)`
      : `${digits.length} of ${LANDLINE_MIN} to ${LANDLINE_MAX} (landline)`;
  },
};

/** A box that takes the whole number after a fixed `+`, country code first. */
export const INTERNATIONAL_RULES: DigitRules = {
  noun: 'phone number',
  keepsStored: (stored) => !stored.startsWith('+'),
  parse: (posted) => {
    if (!posted.startsWith('+')) return posted;
    const bare = posted.slice(1).replace(NOISE, '');
    return ALL_DIGITS.test(bare) ? bare : posted;
  },
  post: (digits) => (digits === '' ? '' : `+${digits}`),
  maxFor: () => E164_MAX,
  cleanPaste: (pasted, whole) => {
    const bare = pasted.replace(NOISE, '');
    // The `+` or `00` dialling prefix is only dropped from a whole number; pasted into part of one,
    // the digits are the user's own (a pasted `0012` keeps its zeros).
    return whole ? bare.replace(/^\+/, '').replace(/^00/, '') : bare;
  },
  refuseDigits: (digits) => (digits.startsWith('0') ? CODE_ZERO : null),
  tooLong: () => `A phone number has at most ${E164_MAX} digits, country code included.`,
  problem: (digits) => {
    if (digits === '') return null;
    if (!ALL_DIGITS.test(digits)) return 'Type the country code and number as digits only.';
    if (digits.startsWith('0')) return CODE_ZERO;
    return digits.length >= E164_MIN
      ? null
      : `A phone number has at least ${E164_MIN} digits, country code included; this has ${digits.length}.`;
  },
  count: (digits) =>
    digits === ''
      ? 'Country code first, then the number'
      : `${digits.length} of ${E164_MAX} at most`,
};

export type PhoneInputProps = DigitBoxProps;

/**
 * Phone number, typed to its data. Nepal is the default: `+977` is a fixed prefix, so the user
 * types only the national number. A mobile number is ten digits starting with 9; a landline is 7
 * to 9 digits. Letters are refused before they go in, a live count sits under the box, and a paste
 * of `+977 98-1234 5678` is cleaned to the national digits. "Number from another country" switches
 * the box to a plain `+` prefix with the country code typed in, because customers and contacts
 * abroad have numbers too. The hidden input named `name` posts E.164 (`+9779812345678`), the form
 * `PhoneSchema` accepts; `onValueChange` reports the same string.
 *
 *   <Field label="Phone">{(control) => <PhoneInput {...control} name="phone" />}</Field>
 */
/** A stored number the Nepal box can show as typed: +977, then digits it would let a user type. */
export function fitsNepalBox(stored: string): boolean {
  if (!stored.startsWith(NEPAL_PREFIX)) return false;
  const national = NEPAL_RULES.parse(stored);
  return (
    ALL_DIGITS.test(national) &&
    !national.startsWith('0') &&
    national.length <= NEPAL_RULES.maxFor(national)
  );
}

export function PhoneInput(props: PhoneInputProps) {
  const {
    value,
    defaultValue,
    onValueChange,
    className,
    edited: editedProp,
    onEditedChange,
    ...rest
  } = props;
  // Whether the user has edited the box now shown. The box remounts on a country switch, so the flag
  // lives here and is kept per country with `left`: a short draft that comes back is still stopped at
  // submit, and typing abroad does not mark an untouched stored Nepal number as edited.
  const [edited, setEdited] = useState(editedProp ?? false);
  const start = value ?? defaultValue ?? '';
  // A stored number the Nepal box cannot hold (a foreign number, or +977 with too many digits) opens
  // in the international box, where it is shown and posted whole.
  const [international, setInternational] = useState(start !== '' && !fitsNepalBox(start));
  // What an uncontrolled box starts with after a switch, and what each country's box held when it was
  // left, so switching by mistake and back does not lose a stored number.
  const [seed, setSeed] = useState(defaultValue ?? '');
  const current = useRef(start);
  useLayoutEffect(() => {
    if (value !== undefined) current.current = value;
  });
  const left = useRef<{ international: boolean; posted: string; edited: boolean } | null>(null);
  const locked = props.disabled === true || props.readOnly === true;

  function toggle() {
    const next = !international;
    const back = left.current?.international === next ? left.current : null;
    const kept = back?.posted ?? '';
    // A mode change is an edit: a stored number without a plus comes back normalised in the international box.
    const restored = next && /^\d+$/.test(kept) ? `+${kept}` : kept;
    const restoredEdited = back?.edited ?? false;
    left.current = { international, posted: current.current, edited };
    current.current = restored;
    setInternational(next);
    setSeed(restored);
    onValueChange?.(restored);
    setEdited(restoredEdited);
    if (restoredEdited !== edited) onEditedChange?.(restoredEdited);
  }

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')}>
      <DigitBox
        // The rules change with the country, so the box remounts. The switch button is outside it,
        // so it keeps focus.
        key={international ? 'international' : 'nepal'}
        {...rest}
        {...(value === undefined ? { defaultValue: seed } : { value })}
        onValueChange={(posted) => {
          current.current = posted;
          onValueChange?.(posted);
        }}
        edited={edited}
        onEditedChange={(next) => {
          setEdited(next);
          onEditedChange?.(next);
        }}
        rules={international ? INTERNATIONAL_RULES : NEPAL_RULES}
        prefix={international ? '+' : NEPAL_PREFIX}
      />
      {locked ? null : (
        <button type="button" className={styles.mode} onClick={toggle}>
          {international
            ? 'Use a Nepal number (' + NEPAL_PREFIX + ')'
            : 'Number from another country'}
        </button>
      )}
    </div>
  );
}
