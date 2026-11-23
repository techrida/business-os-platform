'use client';

import { countryCallingCode, type CountryCode } from '@bos/contracts';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type ReactNode,
} from 'react';

import {
  caretAfterDigits,
  digitCount,
  displayPhone,
  E164_MAX_DIGITS,
  examplePhone,
  couldBeNational,
  interpretTyped,
  refusesExtraDigit,
  type PhoneTyped,
} from './phone-detect';
import { PhoneCountryMenu } from './phone-country-menu';
import styles from './phone-field.module.css';

export interface PhoneFieldProps {
  /** The row's country and whether the user picked it in the flag menu. */
  country: CountryCode;
  picked: boolean;
  /** The number as E.164, partial while typing; `''` when empty. */
  e164: string;
  /** Called with what the typed or pasted text means (the number and the country that follows it). */
  onTyped: (typed: PhoneTyped) => void;
  /** A country picked in the flag menu. */
  onCountry: (country: CountryCode) => void;
  /** The country already shown was picked again. */
  onReselect?: ((country: CountryCode) => void) | undefined;
  onBlur?: (() => void) | undefined;
  /** The text under the field while it has focus ("Mobile: 10 digits, starting with 9"). */
  hint?: string | undefined;
  /** A problem with the number. It takes the field's one message line from the hint (UIP-FORM-010). */
  error?: ReactNode | undefined;
  /** The id of the error text, for the caller's `aria-describedby`. */
  errorId?: string | undefined;
  /** Posted by hidden inputs: `<numberName>` the E.164 number, `<countryName>` the ISO code. */
  numberName?: string | undefined;
  countryName?: string | undefined;
  'aria-label': string;
  'aria-describedby'?: string | undefined;
  invalid?: boolean | undefined;
  disabled?: boolean | undefined;
  /** The label of the flag button ("Phone 1 country"). */
  countryLabel: string;
}

const RAW_PLUS = /^\s*(\+|00)\D*$/;

/**
 * The one-box phone field (R6S, UIP-FORM-007): the flag with a chevron sits inside the left of the field, the number
 * follows and starts with its country code, which therefore appears once. The placeholder is an example number of the
 * selected country. Typing needs no `+`: what the text means is decided by `interpretTyped` (see phone-detect.ts), the
 * text is formatted as it is typed, and the caret stays after the same digit when the text is reformatted.
 *
 * Borrowed from react-international-phone and react-phone-number-input (both MIT): one input with the flag inside,
 * detection of the country from the typed code, and caret by digit count. Their country data and metadata are not
 * used, so the field cannot disagree with the contracts' `phoneProblem`.
 */
export function PhoneField({
  country,
  picked,
  e164,
  onTyped,
  onCountry,
  onReselect,
  onBlur,
  hint,
  error,
  errorId,
  numberName,
  countryName,
  'aria-label': ariaLabel,
  'aria-describedby': describedBy,
  invalid,
  disabled,
  countryLabel,
}: PhoneFieldProps) {
  const base = useId();
  const hintId = `${base}-hint`;
  const noticeId = `${base}-notice`;
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(() => displayPhone(e164));
  const [shownFor, setShownFor] = useState(e164);
  // True while the digits in the box are ones the user typed without a code (the code in front was added for them), so
  // each further digit is judged as a bare national start again: `9`, `97`, `977` under the United States ends as
  // Nepal's code, not as +1 977.
  const [bare, setBare] = useState(false);
  const [focused, setFocused] = useState(false);
  const [notice, setNotice] = useState({ text: '', seq: 0 });
  const caret = useRef<number | null>(null);

  // The number changed from outside (a flag pick, a form reset): show it, formatted.
  if (e164 !== shownFor) {
    setShownFor(e164);
    setText(displayPhone(e164));
    setBare(false);
  }

  useLayoutEffect(() => {
    const input = inputRef.current;
    if (caret.current === null || input === null) return;
    const digits = caret.current;
    caret.current = null;
    if (document.activeElement === input) {
      const at = caretAfterDigits(input.value, digits);
      input.setSelectionRange(at, at);
    }
  });

  function apply(raw: string, digitsBeforeCaret: number | null, via: 'type' | 'paste' = 'type') {
    // While the digits are the user's bare ones, the text is `+<code> <digits>` with the code added for them: take
    // the code off again so they are judged as typed. Edited code, or any text written with a plus: read as given.
    const dial = countryCallingCode(country) ?? '';
    const allDigits = raw.replace(/\D/g, '');
    const source =
      bare && /^\s*\+/.test(raw) && dial !== '' && allDigits.startsWith(dial)
        ? allDigits.slice(dial.length)
        : raw;
    const sourceDigits = source.replace(/\D/g, '').slice(0, E164_MAX_DIGITS);
    // One digit past a complete number is more likely a typo than a foreign code: keep the number, say why.
    if (
      via === 'type' &&
      bare &&
      dial !== '' &&
      refusesExtraDigit(country, e164.slice(1 + dial.length), sourceDigits) &&
      // The own code typed in front of the number (`91 98765 43210` in India) is not a typo.
      !(sourceDigits.startsWith(dial) && couldBeNational(country, sourceDigits.slice(dial.length)))
    ) {
      setText(displayPhone(e164));
      caret.current = digitCount(displayPhone(e164));
      setNotice((previous) => ({
        text: 'That is one digit more than a valid number. Type + first for a number from another country.',
        seq: previous.seq + 1,
      }));
      return;
    }
    const typed = interpretTyped(source, { country, picked }, via);
    const nationalOutcome =
      !/^\s*(\+|00)/.test(source) &&
      typed.e164 !== '' &&
      typed.e164 === `+${countryCallingCode(typed.country) ?? ''}${sourceDigits}`;
    setBare(nationalOutcome);
    // The code shown in front of bare digits is new text: the caret moves past its digits too.
    const codeAdded =
      nationalOutcome && source === raw ? (countryCallingCode(typed.country)?.length ?? 0) : 0;
    const lettersDropped = /[^\d\s+().\p{Pd}]/u.test(raw);
    const overflow = raw.replace(/\D/g, '').length > E164_MAX_DIGITS && !RAW_PLUS.test(raw);
    if (lettersDropped || overflow) {
      setNotice((previous) => ({
        text: lettersDropped
          ? 'A phone number takes digits only.'
          : `A phone number has at most ${E164_MAX_DIGITS} digits, country code included.`,
        seq: previous.seq + 1,
      }));
    }
    // A lone `+` or `00` is the start of a number: keep it on screen until the first digit comes.
    const shown = typed.e164 === '' && RAW_PLUS.test(source) ? '+' : displayPhone(typed.e164);
    setText(shown);
    setShownFor(typed.e164);
    caret.current = digitsBeforeCaret === null ? null : digitsBeforeCaret + codeAdded;
    onTyped(typed);
  }

  // Text typed into the server-rendered box before the page was interactive: take it as typed, once.
  useEffect(() => {
    const input = inputRef.current;
    if (input !== null && input.value !== '' && input.value !== text) apply(input.value, null);
    // Runs once, on mount: `apply` and `text` are the first render's.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.target;
    let value = input.value;
    let at = input.selectionStart ?? value.length;
    const native = event.nativeEvent as InputEvent;
    const forward = native.inputType === 'deleteContentForward';
    // Backspace or Delete over a space or bracket the field added removes nothing by itself: take the neighbouring
    // digit instead, unless that digit is part of the country code shown in front (then nothing is removed).
    if (digitCount(value) === digitCount(text) && value.length < text.length) {
      let index = forward ? at : at - 1;
      while (index >= 0 && index < value.length && !/\d/.test(value[index]!)) {
        index += forward ? 1 : -1;
      }
      if (index >= 0 && index < value.length) {
        const dial = countryCallingCode(country) ?? '';
        if (text.startsWith('+') && digitCount(value, index) < dial.length) {
          setText(text);
          return;
        }
        value = value.slice(0, index) + value.slice(index + 1);
        at = forward ? at : index;
      }
    }
    // More than one digit at once (browser autofill) is a whole number arriving, like a paste.
    const arrived = digitCount(value) - digitCount(text) > 1;
    apply(value, digitCount(value, at), arrived ? 'paste' : 'type');
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const pasted = event.clipboardData.getData('text').trim();
    const start = input.selectionStart ?? 0;
    const end = input.selectionEnd ?? 0;
    const wholeBox = start === 0 && end === input.value.length;
    // A whole number written with its code replaces the field; any other text goes in at the caret, as typed.
    if (/^(\+|00)/.test(pasted) || (wholeBox && pasted !== '')) {
      event.preventDefault();
      apply(pasted, null, 'paste');
    }
  }

  const dial = countryCallingCode(country);
  const placeholder = examplePhone(country);
  const describedIds = [hintId && focused && hint ? hintId : undefined, noticeId, describedBy]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={styles.root}>
      <div
        ref={boxRef}
        className={styles.box}
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
      >
        <PhoneCountryMenu
          value={country}
          onChange={onCountry}
          onReselect={onReselect}
          name={countryName}
          aria-label={countryLabel}
          disabled={disabled}
          invalid={invalid}
          anchorRef={boxRef}
        />
        <input
          ref={inputRef}
          type="tel"
          inputMode="tel"
          autoComplete="tel"
          className={styles.input}
          aria-label={ariaLabel}
          aria-describedby={describedIds || undefined}
          {...(invalid ? { 'aria-invalid': true } : {})}
          disabled={disabled === true}
          value={text}
          placeholder={placeholder}
          data-dial={dial ?? undefined}
          onChange={onChange}
          onPaste={onPaste}
          onFocus={() => setFocused(true)}
          onBlur={() => {
            setFocused(false);
            onBlur?.();
          }}
        />
      </div>
      {numberName ? (
        <input type="hidden" name={numberName} value={e164} disabled={disabled === true} />
      ) : null}
      <p id={noticeId} className="sr-only" role="status" key={notice.seq}>
        {notice.text}
      </p>
      {/* The one reserved message line under the box: present when empty, so the hint that shows on focus and the
          error that replaces it never move the row (UIP-FORM-010). */}
      {error ? (
        <p id={errorId} className={styles.error}>
          {error}
        </p>
      ) : (
        <p id={focused && hint ? hintId : undefined} className={styles.hint}>
          {focused && hint ? hint : null}
        </p>
      )}
    </div>
  );
}
