'use client';

import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';

import { useFormReset } from './use-form-reset';
import styles from './digit-box.module.css';

// The engine behind PanInput and PhoneInput: a box that holds digits and nothing else. One piece of
// state, `text`, is exactly what the box shows. The hidden input posts `rules.post(text)`, so the
// box can never show one value and send another. A key that cannot be a digit, or a digit past the
// length limit, never reaches the box: it is refused and the reason is announced in a `role="status"`
// line, the same way the number inputs do it. A paste has its spaces and dashes taken out first.
// A value from outside that the rules cannot hold (a stored PAN of ten digits) is shown as given
// and flagged, never trimmed to something the user did not see.

/** What differs between one digits-only field and the next. */
export interface DigitRules {
  /** Names the field in refusals: "A PAN takes digits only." */
  noun: string;
  /** A posted or stored value as the box shows it. Text the rules cannot hold comes back as given. */
  parse(posted: string): string;
  /** What the hidden input posts for typed digits; `''` for none. */
  post(digits: string): string;
  /** The most digits the box may hold once it starts with `digits`. */
  maxFor(digits: string): number;
  /** Pasted text reduced to the digits it carries: spaces, dashes and the like go. */
  cleanPaste(pasted: string, whole: boolean): string;
  /** A reason these digits may not be typed, or null (a leading 0 where a country code is shown). */
  refuseDigits?(digits: string): string | null;
  /**
   * True for a stored value whose digits the box can show but that must keep posting as stored until the user edits
   * it, because posting the box's own form would change what the value means (an unprefixed `4123456` is not `+4123456`).
   */
  keepsStored?(stored: string): boolean;
  /** The reason typing past the limit is refused. */
  tooLong(digits: string): string;
  /** What is wrong with the digits as a finished value, or null. Empty is the caller's `required`. */
  problem(digits: string): string | null;
  /** The live count under the box: "7 of 9". */
  count(digits: string): string;
}

export interface DigitBoxProps {
  /** `Field` passes its control id here, so its `<label for>` names the visible box. */
  id?: string | undefined;
  /** Posted by a hidden input. The visible box has no name. */
  name?: string | undefined;
  /** Controlled value, in the posted form. */
  value?: string | undefined;
  /** Uncontrolled initial value; also what a form reset restores. */
  defaultValue?: string | undefined;
  /** Called with the posted value whenever it changes. */
  onValueChange?: ((posted: string) => void) | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  placeholder?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
  /**
   * Whether the user has edited the box. A box that remounts (a country switch) is handed the flag it
   * had, so a short draft is still stopped at submit. Starts false; reported through `onEditedChange`.
   */
  edited?: boolean | undefined;
  onEditedChange?: ((edited: boolean) => void) | undefined;
}

interface EngineProps extends DigitBoxProps {
  rules: DigitRules;
  /** Fixed text before the digits (`+977`). It is part of the posted value, not the box. */
  prefix?: string | undefined;
}

const DIGITS = /^\d*$/;

export function DigitBox({
  id,
  name,
  value,
  defaultValue,
  onValueChange,
  required,
  disabled,
  readOnly,
  placeholder,
  'aria-describedby': callerDescribedBy,
  'aria-invalid': callerInvalid,
  'aria-labelledby': labelledBy,
  'aria-label': ariaLabel,
  className,
  edited,
  onEditedChange,
  rules,
  prefix,
}: EngineProps) {
  const base = useId();
  const prefixId = `${base}-prefix`;
  const countId = `${base}-count`;
  const statusId = `${base}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const controlled = value !== undefined;
  const [text, setText] = useState(() => rules.parse(controlled ? value : (defaultValue ?? '')));
  // A stored value the rules cannot hold is flagged from the first render, so the server HTML and
  // the hydrated box agree.
  const [error, setError] = useState<string | null>(() =>
    !DIGITS.test(text) || text.length > rules.maxFor(text) ? rules.problem(text) : null,
  );
  // `seq` changes on every refusal so a repeated message is a new DOM node and is announced again.
  const [notice, setNotice] = useState({ text: '', seq: 0 });
  const [, setCaretTick] = useState(0);

  const touched = useRef(edited ?? false);

  /** True when the box holds something typing could not produce (letters, too many digits). */
  const foreign = (shown: string) => !DIGITS.test(shown) || shown.length > rules.maxFor(shown);
  // A stored value the box would rewrite into a different number keeps posting as stored until the user makes an accepted edit (even one that ends on the same digits).
  const [asStored] = useState(() => {
    const raw = (controlled ? value : defaultValue) ?? '';
    return raw !== '' && rules.keepsStored?.(raw) === true
      ? { shown: rules.parse(raw), raw }
      : null;
  });
  const postedOf = (shown: string) =>
    asStored !== null && !touched.current && shown === asStored.shown
      ? asStored.raw
      : foreign(shown)
        ? shown
        : rules.post(shown);

  // A controlled parent that holds a different value wins: it refused the edit or set a new one.
  if (controlled && postedOf(text) !== value) {
    const shown = rules.parse(value);
    if (postedOf(shown) !== postedOf(text)) {
      setText(shown);
      setError(foreign(shown) ? rules.problem(shown) : null);
    }
  }

  const textRef = useRef(text);
  const emitted = useRef(postedOf(text));
  useLayoutEffect(() => {
    textRef.current = text;
    emitted.current = postedOf(text);
  });

  // True once the user has edited the box. A stored value nobody touched is never blocked at submit.
  const pendingCaret = useRef<number | null>(null);
  useLayoutEffect(() => {
    const input = inputRef.current;
    const caret = pendingCaret.current;
    if (!input || caret === null) return;
    pendingCaret.current = null;
    if (document.activeElement === input) input.setSelectionRange(caret, caret);
  });
  function placeCaret(caret: number) {
    pendingCaret.current = caret;
    setCaretTick((tick) => tick + 1);
  }

  function commit(next: string) {
    textRef.current = next;
    setText(next);
    const posted = postedOf(next);
    if (posted !== emitted.current) {
      emitted.current = posted;
      onValueChange?.(posted);
    }
  }
  function refuse(reason: string) {
    setNotice((last) => ({ text: reason, seq: last.seq + 1 }));
  }
  function clearNotice() {
    setNotice((last) => (last.text === '' ? last : { text: '', seq: last.seq }));
  }

  /** Why `next` may not become the box's text, or null. Used for a key, a paste and a whole new text. */
  function refusalOf(next: string, deleting = false): string | null {
    if (!DIGITS.test(next)) {
      return /^[\d\s-]*$/.test(next)
        ? `Spaces and dashes are not needed. Type the digits only.`
        : `A ${rules.noun} takes digits only.`;
    }
    // A delete is never refused: what it leaves (a 0 in front) is flagged when the box is left.
    const barred = deleting ? null : rules.refuseDigits?.(next);
    if (barred) return barred;
    if (next.length > rules.maxFor(next)) return rules.tooLong(next);
    return null;
  }

  function accept(next: string, caret: number | null) {
    if (!touched.current) onEditedChange?.(true);
    touched.current = true;
    clearNotice();
    commit(next);
    if (caret !== null) placeCaret(caret);
    // A standing blur error is cleared once the value is fine; it is never brought in mid-typing,
    // because a short value is on its way up.
    setError((standing) => (standing && rules.problem(next) === null ? null : standing));
  }

  useFormReset(rootRef, () => {
    if (touched.current) onEditedChange?.(false);
    touched.current = false;
    clearNotice();
    const next = rules.parse(controlled ? value : (defaultValue ?? ''));
    setError(null);
    if (controlled) {
      textRef.current = next;
      emitted.current = postedOf(next);
      setText(next);
      return;
    }
    commit(next);
  });

  // The forms that hold these boxes are `noValidate` and the contracts accept a shorter number, so a
  // number the user typed but left incomplete is stopped at submit, with its reason and focus on the
  // box. A function action does not run when its submit event is cancelled.
  const onFormSubmit = useEffectEvent((event: Event) => {
    if (disabled || !touched.current) return;
    const current = textRef.current;
    const found = rules.problem(current);
    if (found === null) return;
    event.preventDefault();
    setError(found);
    inputRef.current?.focus();
  });
  useEffect(() => {
    const form = rootRef.current?.closest('form');
    if (!form) return;
    const listener = (event: Event) => onFormSubmit(event);
    form.addEventListener('submit', listener, true);
    return () => form.removeEventListener('submit', listener, true);
  }, []);

  // Soft keyboards send keydown "Unidentified", so a typed character is judged in `beforeinput`,
  // where a refused one is cancelled before it reaches the box and the caret stays put.
  const onNativeBeforeInput = useEffectEvent((event: Event) => {
    const { inputType, data } = event as InputEvent;
    const input = inputRef.current;
    if (!input || inputType !== 'insertText' || !data || !event.cancelable) return;
    const current = textRef.current;
    if (foreign(current)) return;
    const start = input.selectionStart ?? current.length;
    const end = input.selectionEnd ?? start;
    const reason = refusalOf(current.slice(0, start) + data + current.slice(end));
    if (reason) {
      event.preventDefault();
      refuse(reason);
    }
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const listener = (event: Event) => onNativeBeforeInput(event);
    input.addEventListener('beforeinput', listener);
    return () => input.removeEventListener('beforeinput', listener);
  }, []);

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    if (disabled || readOnly) return;
    const input = event.currentTarget;
    const raw = input.value;
    const caret = input.selectionStart ?? raw.length;
    const current = textRef.current;
    // Editing a stored value the box cannot hold: deleting is always allowed, so it can be repaired.
    if (foreign(current) && raw.length <= current.length) return accept(raw, caret);
    const reason = refusalOf(raw, raw.length < current.length);
    if (reason) {
      refuse(reason);
      placeCaret(Math.max(0, Math.min(current.length, caret - (raw.length - current.length))));
      return;
    }
    accept(raw, caret);
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    if (disabled || readOnly) return;
    const input = event.currentTarget;
    event.preventDefault();
    const current = textRef.current;
    const start = input.selectionStart ?? current.length;
    const end = input.selectionEnd ?? start;
    // Whole number: nothing is left of the box once the selection is replaced.
    const whole = current.slice(0, start) + current.slice(end) === '';
    const pasted = rules.cleanPaste(event.clipboardData.getData('text'), whole);
    const next = current.slice(0, start) + pasted + current.slice(end);
    const reason = refusalOf(next);
    if (reason) {
      refuse(reason);
      return;
    }
    accept(next, start + pasted.length);
  }

  function onBlur() {
    clearNotice();
    setError(rules.problem(textRef.current));
  }

  const digits = foreign(text) ? '' : text;
  const countText = foreign(text) ? '' : rules.count(digits);
  const status = notice.text || error || '';
  const invalid = callerInvalid === true || callerInvalid === 'true' || error !== null;
  // Order: the caller's hint, the prefix and count, then errors (the caller's, then ours).
  // `Field` names its error element `<id>-error`.
  const callerIds = callerDescribedBy?.split(/\s+/).filter(Boolean) ?? [];
  const describedBy =
    [
      ...callerIds.filter((ref) => !ref.endsWith('-error')),
      prefix ? prefixId : undefined,
      countText ? countId : undefined,
      ...callerIds.filter((ref) => ref.endsWith('-error')),
      status ? statusId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const posted = postedOf(text);

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <div
        className={styles.box}
        data-invalid={invalid || undefined}
        onMouseDown={(event) => {
          const input = inputRef.current;
          const target = event.target as Element;
          if (!input || disabled || target === input) return;
          event.preventDefault();
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        }}
      >
        {prefix ? (
          <span id={prefixId} className={styles.affix}>
            {prefix}
          </span>
        ) : null}
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          value={text}
          onChange={onChange}
          onPaste={onPaste}
          onBlur={onBlur}
          {...(id === undefined ? {} : { id })}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          {...(invalid ? { 'aria-invalid': true } : {})}
          required={required === true}
          disabled={disabled === true}
          readOnly={readOnly === true}
        />
      </div>
      {name ? (
        <input type="hidden" name={name} value={posted} disabled={disabled === true} />
      ) : null}
      <div className={styles.meta}>
        <div
          id={statusId}
          role="status"
          className={styles.status}
          data-tone={status ? 'error' : undefined}
        >
          {/* Two spans, so a standing blur error is not read out again when a refusal comes and goes. */}
          {notice.text ? <span key={notice.seq}>{notice.text}</span> : null}
          {error ? <span key="error">{error}</span> : null}
        </div>
        {countText ? (
          <span id={countId} className={styles.count}>
            {countText}
          </span>
        ) : null}
      </div>
    </div>
  );
}
