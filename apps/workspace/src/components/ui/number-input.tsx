'use client';

import { MONEY_LIMITS, PERCENT_LIMITS, QUANTITY_LIMITS } from '@bos/contracts';
import {
  amountInWords,
  Dec,
  fitsWhileTyping,
  formatMoney,
  groupDigits,
  normalisePastedNumber,
  plainAmount,
  refusalMessage,
  withinLimits,
  type Currency,
  type NumberCheck,
  type NumberLimits,
  type NumberRefusal,
  type NumberSystem,
  type NumberSystems,
} from '@bos/locale';
import {
  useEffect,
  useEffectEvent,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';

import { useNumberSystems } from './number-system-context';
import { useFormReset } from './use-form-reset';
import styles from './number-input.module.css';

// One piece of state, `text`, is exactly what the box shows. The hidden input posts that text with
// the grouping commas and a bare trailing point taken out, and onValueChange reports the same
// string, so the box can never show one amount and send another. Padding (`100.00`) is part of the
// text and is posted with it. Text typed before hydration is not in the hidden input, which renders
// the server value: the same exposure as every controlled input.

/** Props every number input takes. Values are plain decimal strings (`"1250000.5"`), `""` when empty. */
export interface NumberInputCommonProps {
  /** `Field` passes its control id here, so its `<label for>` names the visible box. */
  id?: string | undefined;
  /** Posted by a hidden input as the plain decimal string. The visible box has no name. */
  name?: string | undefined;
  /** Controlled value. */
  value?: string | undefined;
  /** Uncontrolled initial value; also what a form reset restores. */
  defaultValue?: string | undefined;
  /** Called with the plain decimal string whenever the posted value changes. */
  onValueChange?: ((plain: string) => void) | undefined;
  /** Bounds as plain decimal strings, compared exactly. A keystroke past `max` is refused. */
  min?: string | undefined;
  max?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  placeholder?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
}

interface Spin {
  step: string;
  /** Names the stepper buttons: "Decrease quantity". Null hides the buttons; the arrow keys still step. */
  buttonNoun: string | null;
}

interface EngineProps extends NumberInputCommonProps {
  limits: NumberLimits;
  /** Live digit grouping, or null for none. */
  grouping: NumberSystem | null;
  prefix?: string | undefined;
  suffix?: string | undefined;
  /** Decimals the box pads to on blur and for values set from outside. */
  padTo?: number | undefined;
  /** Zero is an error on blur (QuantityString needs more than zero). */
  positive?: boolean | undefined;
  /** How a bound reads in a refusal: `NPR 20,18,180.00`, `100%`. */
  describe: (plain: string) => string;
  spin?: Spin | undefined;
  words?: ((plain: string) => string) | undefined;
}

/** A blur-time problem. `zero` is the positive-quantity rule, which the locale package does not name. */
interface Problem {
  reason: NumberRefusal | 'zero';
  message: string;
}

const ABOVE_ZERO = 'Must be above zero.';
/** Problems a value passes through on its way up (5 on the way to 50), never shown mid-typing. */
const LOWER_BOUND = new Set<Problem['reason']>(['below_min', 'zero']);

const DIGITS = /^\d*\.?\d*$/;
const ungroup = (text: string) => text.replaceAll(',', '');
/** What the hidden input posts for typed text: the grouping commas and a bare trailing point go. */
const plainOf = (text: string) => ungroup(text).replace(/\.$/, '');

const isDecimal = (text: string) => /^(\d+\.?\d*|\.\d+)$/.test(text);

/** Equal as numbers (`1.0` and `1`), so a parent that canonicalises its copy does not erase typing. */
function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  return isDecimal(a) && isDecimal(b) && new Dec(a).eq(new Dec(b));
}

function groupWhole(whole: string, grouping: NumberSystem | null): string {
  return grouping && whole !== '' ? groupDigits(whole, grouping) : whole;
}

/**
 * Typed digits (matching DIGITS) as the box shows them: `007` is `7` and `.5` is `0.5`, so even a
 * form submitted with Enter before blur posts a string the contract patterns accept. A lone point
 * stays, so the next digit can follow it.
 */
function display(raw: string, grouping: NumberSystem | null): string {
  if (raw === '' || raw === '.') return raw;
  const [whole = '', fraction] = raw.split('.');
  const grouped = groupWhole(whole.replace(/^0+(?=\d)/, '') || '0', grouping);
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

/** How many digits and points sit before the caret once `raw` is shown as `display(raw)`. */
function displayCount(raw: string, before: number): number {
  const whole = raw.split('.')[0] ?? '';
  const stripped = whole.length - whole.replace(/^0+(?=\d)/, '').length;
  const added = whole === '' && raw !== '' && raw !== '.' ? 1 : 0;
  return before - Math.min(stripped, before) + added;
}

/** The caret index in `shown` with `count` digits and points before it. */
function caretAfter(shown: string, count: number): number {
  if (count <= 0) return 0;
  let seen = 0;
  for (let index = 0; index < shown.length; index += 1) {
    if (shown[index] !== ',') seen += 1;
    if (seen === count) return index + 1;
  }
  return shown.length;
}

/** The whole part of `plain` grouped as this field groups it, or null for a field without grouping. */
function regroup(plain: string, grouping: NumberSystem | null): string | null {
  if (!grouping) return null;
  const [whole = '', fraction] = plain.split('.');
  return groupWhole(whole, grouping) + (fraction === undefined ? '' : `.${fraction}`);
}

/**
 * A value from outside (default, controlled value, reset) as the box shows it. Commas are taken out
 * only when they are valid grouping (`12,50,000`); `1,5` is a decimal comma and stays. Zero-only
 * decimals past the field's scale are dropped (`12.5000` is `12.50` in a 2-decimal field), because
 * the server sends numeric columns at full scale. A value the field cannot hold (`-1250.50`, `1,5`,
 * `12.5555` in a 2-decimal field) is shown exactly as given, so what posts is what the user sees.
 */
function fromValue(
  value: string,
  limits: NumberLimits,
  grouping: NumberSystem | null,
  padTo: number | undefined,
): string {
  if (value === '') return '';
  let trimmed = value.includes(',') ? plainAmount(value) : value;
  const [whole = '', fraction] = trimmed.split('.');
  if (fraction !== undefined && fraction.length > limits.scale) {
    if (/^0*$/.test(fraction.slice(limits.scale))) {
      const kept = fraction.slice(0, limits.scale);
      trimmed = kept === '' ? whole : `${whole}.${kept}`;
    }
  }
  const check = withinLimits(trimmed, limits);
  if (!check.ok) return value;
  return display(padTo === undefined ? check.value : new Dec(check.value).toFixed(padTo), grouping);
}

/** Why typed or inserted text is refused before it reaches the box, or null when it may go in. */
function refusedText(text: string, scale: number, pointElsewhere: boolean): NumberRefusal | null {
  let hasPoint = pointElsewhere;
  for (const char of text) {
    if (char >= '0' && char <= '9') continue;
    if (char === '.') {
      if (scale === 0) return 'too_many_decimals';
      if (hasPoint) return 'not_a_number';
      hasPoint = true;
      continue;
    }
    if (char === ',') return 'comma';
    if (/\s/.test(char)) return 'space';
    return 'not_a_number';
  }
  return null;
}

/** True when the box holds a point outside the current selection (the selection is about to be replaced). */
function pointOutsideSelection(input: HTMLInputElement): boolean {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return (input.value.slice(0, start) + input.value.slice(end)).includes('.');
}

/** Digits that a JavaScript number holds exactly; past this aria-valuenow would be rounded. */
const EXACT_DIGITS = 15;

const setInputValue = (input: HTMLInputElement, text: string) =>
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);

// Desktop Backspace moves the caret off a separator in keydown and the browser then deletes the
// digit. Android sends keydown "Unidentified", so the browser would delete the separator itself and
// regrouping would put it straight back. Delete the digit instead.
function deleteAcrossSeparator(event: Event, input: HTMLInputElement, backward: boolean) {
  const start = input.selectionStart;
  if (start === null || start !== input.selectionEnd) return;
  const text = input.value;
  if (text[backward ? start - 1 : start] !== ',') return;
  const digit = backward ? start - 2 : start + 1;
  if (digit < 0 || digit >= text.length) return;
  event.preventDefault();
  setInputValue(input, text.slice(0, digit) + text.slice(digit + 1));
  const caret = backward ? digit : start;
  input.setSelectionRange(caret, caret);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

/**
 * The library-free engine. react-number-format keeps its own copy of the text and re-syncs it only
 * when the formatted prop changes, so a refused or overridden edit left the box out of step with
 * the posted value. Here React's controlled input restores `text` after any refused change.
 */
function NumberBox({
  id,
  name,
  value,
  defaultValue,
  onValueChange,
  min,
  max,
  required,
  disabled,
  readOnly,
  placeholder,
  'aria-describedby': callerDescribedBy,
  'aria-invalid': callerInvalid,
  'aria-labelledby': labelledBy,
  'aria-label': ariaLabel,
  className,
  limits,
  grouping,
  prefix,
  suffix,
  padTo,
  positive,
  describe,
  spin,
  words,
}: EngineProps) {
  const base = useId();
  const prefixId = `${base}-prefix`;
  const suffixId = `${base}-suffix`;
  const wordsId = `${base}-words`;
  const statusId = `${base}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const controlled = value !== undefined;
  const hasMin = min !== undefined && min !== '';
  const hasMax = max !== undefined && max !== '';
  const bounds = {
    min: hasMin ? describe(min) : undefined,
    max: hasMax ? describe(max) : undefined,
  };
  const rawBounds = { min: hasMin ? min : undefined, max: hasMax ? max : undefined };

  /**
   * True when the text is something typing could not produce: a negative or over-long server value,
   * or a comma that is not this field's grouping (`1,5`).
   */
  function foreign(text: string): boolean {
    const plain = ungroup(text);
    if (!DIGITS.test(plain) || !fitsWhileTyping(plain, limits)) return true;
    return text.includes(',') && regroup(plain, grouping) !== text;
  }

  /** What the hidden input posts: typed text without its grouping, a foreign text exactly as shown. */
  function postedOf(text: string): string {
    return foreign(text) ? text : plainOf(text);
  }

  /** What is wrong with the text as a finished value, or null when it is acceptable. */
  function problem(text: string): Problem | null {
    const posted = postedOf(text);
    if (posted === '') {
      return required ? { reason: 'empty', message: refusalMessage('empty', limits) } : null;
    }
    const check = withinLimits(posted, limits, rawBounds);
    if (!check.ok) {
      const reason = posted.includes(',') ? 'comma' : check.reason;
      return { reason, message: refusalMessage(reason, limits, bounds) };
    }
    if (positive && new Dec(check.value).lte(0)) return { reason: 'zero', message: ABOVE_ZERO };
    return null;
  }

  const initial = () =>
    fromValue(controlled ? value : (defaultValue ?? ''), limits, grouping, padTo);
  const [text, setText] = useState(initial);
  // A server value the field cannot hold is flagged from the first render, so the server HTML and
  // the hydrated box agree.
  const [error, setError] = useState<Problem | null>(() => {
    const first = initial();
    return foreign(first) ? problem(first) : null;
  });
  // `seq` changes on every refusal so a repeated message is a new DOM node and is announced again.
  const [notice, setNotice] = useState({ text: '', seq: 0 });
  const [, setCaretTick] = useState(0);

  // A controlled parent that holds a different number wins: it refused the edit or set a new value.
  // The comparison is with the parent value as the box would show it, so a rebuilt text always
  // matches on the next render (`1,250,000` is shown as `12,50,000.00`).
  const fromParent = controlled ? fromValue(value, limits, grouping, padTo) : '';
  if (controlled && !sameNumber(postedOf(text), postedOf(fromParent))) {
    setText(fromParent);
    setError(foreign(fromParent) ? problem(fromParent) : null);
  }

  // Handlers may run back to back in one event, so they read and write these rather than state from
  // the last render. They follow every commit, not only a changed `text`: when a controlled parent
  // refuses an edit, the committed text is unchanged while these still hold the refused one.
  const textRef = useRef(text);
  const emitted = useRef(postedOf(text));
  useLayoutEffect(() => {
    textRef.current = text;
    emitted.current = postedOf(text);
  });

  // Set by our beforeinput listener: 'ok' for an edit at the caret it has seen, a refusal for a
  // non-cancelable insert it judged bad, null when the next change came from elsewhere (autofill, a
  // script, undo) and must pass the strict whole-text check.
  const keyed = useRef<'ok' | NumberRefusal | null>(null);
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
    // A refused change leaves `text` as it was, so this render is what puts the caret back after
    // React restores the old value.
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

  function refuse(reason: NumberRefusal) {
    const message = refusalMessage(reason, limits, bounds);
    setNotice((last) => ({ text: message, seq: last.seq + 1 }));
  }

  function clearNotice() {
    setNotice((last) => (last.text === '' ? last : { text: '', seq: last.seq }));
  }

  function accept(next: string, caret: number | null) {
    clearNotice();
    commit(next);
    if (caret !== null) placeCaret(caret);
    // A standing error is checked again: cleared once the value is fine, kept while it still
    // applies, replaced when it no longer describes the value. A min error is never brought in
    // mid-typing, because the value passes below min on its way up.
    setError((standing) => {
      if (!standing) return standing;
      const now = problem(next);
      if (!now) return null;
      if (now.reason === standing.reason) return now;
      return LOWER_BOUND.has(now.reason) ? null : now;
    });
  }

  useFormReset(rootRef, () => {
    clearNotice();
    keyed.current = null;
    const next = fromValue(controlled ? value : (defaultValue ?? ''), limits, grouping, padTo);
    setError(foreign(next) ? problem(next) : null);
    // A controlled parent owns the value; reporting the reset to it would undo its state.
    if (controlled) {
      textRef.current = next;
      emitted.current = postedOf(next);
      setText(next);
      return;
    }
    commit(next);
  });

  // Soft keyboards often send keydown with key "Unidentified", so the inserted text is checked again
  // here. React's onBeforeInput is a polyfill over other events, hence the native listener.
  const onNativeBeforeInput = useEffectEvent((event: Event) => {
    const { inputType, data } = event as InputEvent;
    const input = inputRef.current;
    keyed.current = null;
    if (!input || !inputType) return;
    if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') {
      keyed.current = 'ok';
      deleteAcrossSeparator(event, input, inputType === 'deleteContentBackward');
      return;
    }
    if (inputType.startsWith('delete')) {
      keyed.current = 'ok';
      return;
    }
    // Replacement text, drops, pastes and history steps go through the strict check instead.
    if ((inputType !== 'insertText' && inputType !== 'insertCompositionText') || !data) return;
    const reason = refusedText(data, limits.scale, pointOutsideSelection(input));
    if (!reason) {
      keyed.current = 'ok';
    } else if (event.cancelable) {
      event.preventDefault();
      refuse(reason);
    } else {
      // A composition insert cannot be cancelled; the change handler refuses it.
      keyed.current = reason;
    }
  });
  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    const listener = (event: Event) => onNativeBeforeInput(event);
    // A keystroke that changes nothing (5 typed over a selected 5) fires input but not onChange, so
    // its verdict would vouch for the next change, such as autofill. This document listener runs
    // after React's own root listener for every input event and drops the verdict.
    const consumed = (event: Event) => {
      if (event.target === input) keyed.current = null;
    };
    const page = input.ownerDocument;
    input.addEventListener('beforeinput', listener);
    page.addEventListener('input', consumed);
    return () => {
      input.removeEventListener('beforeinput', listener);
      page.removeEventListener('input', consumed);
    };
  }, []);

  /** Why a whole new text that did not come through our handlers is refused, or null. */
  function strictRefusal(raw: string): NumberRefusal | null {
    if (DIGITS.test(raw)) return null;
    const plain = ungroup(raw);
    if (DIGITS.test(plain) && regroup(plain, grouping) === raw) return null;
    return refusedText(raw, limits.scale, false) ?? 'not_a_number';
  }

  function overLimit(plain: string): NumberRefusal {
    if (limits.scale === 0 && plain.includes('.')) return 'too_many_decimals';
    const fraction = plain.split('.')[1] ?? '';
    return fraction.length > limits.scale ? 'too_many_decimals' : 'too_many_digits';
  }

  function onChange(event: ChangeEvent<HTMLInputElement>) {
    const input = event.currentTarget;
    const raw = input.value;
    const caret = input.selectionStart ?? raw.length;
    const verdict = keyed.current;
    keyed.current = null;
    const current = textRef.current;
    if (disabled || readOnly) return;
    const refuseEdit = (reason: NumberRefusal) => {
      refuse(reason);
      placeCaret(Math.max(0, Math.min(current.length, caret - (raw.length - current.length))));
    };
    if (verdict !== null && verdict !== 'ok') return refuseEdit(verdict);
    if (verdict === null) {
      const reason = strictRefusal(raw);
      if (reason) return refuseEdit(reason);
    }
    // Editing a server value the field cannot hold: the edit stays as typed, unformatted, until it
    // becomes a value the field can hold. The blur check keeps reporting what is wrong.
    if (verdict === 'ok' && foreign(current) && foreign(raw)) return accept(raw, caret);
    const plain = ungroup(raw);
    if (!DIGITS.test(plain) || !fitsWhileTyping(plain, limits)) {
      return refuseEdit(
        DIGITS.test(plain)
          ? overLimit(plain)
          : (refusedText(plain, limits.scale, false) ?? 'not_a_number'),
      );
    }
    const next = display(plain, grouping);
    const check = withinLimits(postedOf(next), limits);
    if (hasMax && check.ok && new Dec(check.value).gt(new Dec(max))) {
      return refuseEdit('above_max');
    }
    accept(next, caretAfter(next, displayCount(plain, ungroup(raw.slice(0, caret)).length)));
  }

  /** The number to step from: the value as posted, or null when it is not a plain number. */
  function stepBase(source: string): Dec | null {
    const posted = postedOf(source);
    if (posted === '') return new Dec(0);
    return isDecimal(posted) ? new Dec(posted) : null;
  }
  const shownBase = stepBase(text);
  const atMin = hasMin && shownBase !== null && shownBase.lte(new Dec(min));
  const atMax = hasMax && shownBase !== null && shownBase.gte(new Dec(max));

  // The next value is rounded to the field's scale before it meets the bounds, so a max finer than
  // the scale (99.99995 in a 4-decimal field) can never let a rounded 100 through.
  function stepBy(direction: 1 | -1) {
    if (!spin || disabled || readOnly) return;
    const from = stepBase(textRef.current);
    if (!from) {
      refuse('not_a_number');
      return;
    }
    let next = from.plus(new Dec(spin.step).times(direction)).toDecimalPlaces(limits.scale);
    if (hasMin && next.lt(new Dec(min))) {
      next = new Dec(min).toDecimalPlaces(limits.scale, Dec.ROUND_UP);
    }
    if (hasMax && next.gt(new Dec(max))) {
      const top = new Dec(max).toDecimalPlaces(limits.scale, Dec.ROUND_DOWN);
      if (!top.gt(from)) {
        refuse('above_max');
        return;
      }
      next = top;
    }
    const check = withinLimits(next.toFixed(), limits);
    if (!check.ok) {
      refuse(check.reason);
      return;
    }
    accept(display(check.value, grouping), null);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    keyed.current = null;
    const input = event.currentTarget;
    if (spin && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      stepBy(event.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    if (event.key === 'Backspace' || event.key === 'Delete') {
      const start = input.selectionStart;
      if (start === null || start !== input.selectionEnd) return;
      // Step over a separator so the browser deletes the digit next to it.
      if (event.key === 'Backspace' && input.value[start - 1] === ',') {
        input.setSelectionRange(start - 1, start - 1);
      } else if (event.key === 'Delete' && input.value[start] === ',') {
        input.setSelectionRange(start + 1, start + 1);
      }
      return;
    }
    if (event.key.length !== 1) return;
    const reason = refusedText(event.key, limits.scale, pointOutsideSelection(input));
    if (reason) {
      event.preventDefault();
      refuse(reason);
    }
  }

  // Raw clipboard or dropped text is judged before it reaches the box: `1,5` is never 15. An empty
  // box or a full selection is replaced; otherwise the text goes in at the caret or over the
  // selection, as a browser would, and the whole result is judged.
  function insertText(inserted: string, start: number, end: number) {
    if (disabled || readOnly || inserted === '') return;
    const shown = textRef.current;
    const replaceAll = shown === '' || (start === 0 && end === shown.length);
    if (replaceAll) {
      const check = normalisePastedNumber(inserted, limits, rawBounds);
      if (!check.ok) {
        refuse(check.reason);
        return;
      }
      const next = display(check.value, grouping);
      accept(next, next.length);
      return;
    }
    const piece = inserted.trim();
    let pieceValue = piece;
    if (!DIGITS.test(piece)) {
      const pieceCheck = normalisePastedNumber(piece, limits);
      if (!pieceCheck.ok) {
        refuse(pieceCheck.reason);
        return;
      }
      pieceValue = pieceCheck.value;
    }
    const head = ungroup(shown.slice(0, start)) + pieceValue;
    const combined = head + ungroup(shown.slice(end));
    const check: NumberCheck = withinLimits(combined, limits, rawBounds);
    if (!check.ok) {
      refuse(check.reason);
      return;
    }
    const next = display(combined, grouping);
    accept(next, caretAfter(next, displayCount(combined, head.length)));
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const input = event.currentTarget;
    const inserted =
      event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    const start = input.selectionStart ?? input.value.length;
    insertText(inserted, start, input.selectionEnd ?? start);
  }

  // The drop point is not known here, so a drop replaces the whole value.
  function onDrop(event: DragEvent<HTMLInputElement>) {
    event.preventDefault();
    const input = event.currentTarget;
    input.focus();
    const inserted = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text');
    insertText(inserted, 0, input.value.length);
  }

  function onBlur() {
    keyed.current = null;
    const current = textRef.current;
    // Typed text is tidied (`12.` is 12, a lone point is empty) and padded. A value the field cannot
    // hold is left as it is and reported, never replaced with something the user did not see.
    if (!foreign(current)) {
      const posted = postedOf(current);
      const check = withinLimits(posted, limits);
      let next = current;
      if (posted === '') next = '';
      else if (check.ok) {
        const padded = padTo === undefined ? check.value : new Dec(check.value).toFixed(padTo);
        next = display(padded, grouping);
      }
      if (next !== current) commit(next);
    }
    clearNotice();
    setError(problem(textRef.current));
  }

  // Pressing the prefix, unit or padding puts the caret in the box, as on a single native input.
  function onBoxMouseDown(event: MouseEvent<HTMLDivElement>) {
    const input = inputRef.current;
    const target = event.target as Element;
    if (!input || disabled || target === input || target.closest('button')) return;
    event.preventDefault();
    input.focus();
    input.setSelectionRange(input.value.length, input.value.length);
  }

  // A lone point in a required box posts nothing, but it is not empty to the browser's own
  // `required` check, so the form would submit an empty value without this.
  const pointOnly = required === true && text !== '' && postedOf(text) === '';
  const validityMessage = pointOnly ? refusalMessage('empty', limits) : '';
  useLayoutEffect(() => {
    inputRef.current?.setCustomValidity(validityMessage);
  }, [validityMessage]);

  const finished = withinLimits(postedOf(text), limits);
  const plain = finished.ok ? finished.value : '';
  const wordsText = words && plain !== '' ? words(plain) : '';
  const status = notice.text || error?.message || '';
  const invalid = callerInvalid === true || callerInvalid === 'true' || error !== null || pointOnly;
  // Order: the caller's hint, the prefix and unit, the words, then errors (the caller's, then ours).
  // `Field` names its error element `<id>-error`, which is how its error is kept after the words.
  const callerIds = callerDescribedBy?.split(/\s+/).filter(Boolean) ?? [];
  const describedBy =
    [
      ...callerIds.filter((ref) => !ref.endsWith('-error')),
      prefix ? prefixId : undefined,
      suffix ? suffixId : undefined,
      wordsText ? wordsId : undefined,
      ...callerIds.filter((ref) => ref.endsWith('-error')),
      status ? statusId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const unit = suffix ? (suffix === '%' ? '%' : ` ${suffix}`) : '';
  const valueText = plain === '' ? undefined : `${groupPlain(plain, grouping)}${unit}`;
  const significant = plain.replace('.', '').replace(/^0+/, '').length;

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <div className={styles.box} data-invalid={invalid || undefined} onMouseDown={onBoxMouseDown}>
        {prefix ? (
          <span id={prefixId} className={styles.affix}>
            {prefix}
          </span>
        ) : null}
        <input
          ref={inputRef}
          className={styles.input}
          type="text"
          inputMode={limits.scale === 0 ? 'numeric' : 'decimal'}
          autoComplete="off"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onDrop={onDrop}
          onBlur={onBlur}
          {...(id === undefined ? {} : { id })}
          {...(placeholder === undefined ? {} : { placeholder })}
          {...(ariaLabel === undefined ? {} : { 'aria-label': ariaLabel })}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          {...(invalid ? { 'aria-invalid': true } : {})}
          {...(spin
            ? {
                role: 'spinbutton',
                ...(plain === '' || significant > EXACT_DIGITS
                  ? {}
                  : { 'aria-valuenow': Number(plain) }),
                ...(hasMin ? { 'aria-valuemin': Number(min) } : {}),
                ...(hasMax ? { 'aria-valuemax': Number(max) } : {}),
                ...(valueText === undefined ? {} : { 'aria-valuetext': valueText }),
              }
            : {})}
          required={required === true}
          disabled={disabled === true}
          readOnly={readOnly === true}
        />
        {suffix ? (
          <span id={suffixId} className={styles.affix}>
            {suffix}
          </span>
        ) : null}
        {spin?.buttonNoun ? (
          <span className={styles.steppers}>
            <button
              type="button"
              tabIndex={-1}
              className={styles.stepper}
              aria-label={`Decrease ${spin.buttonNoun}`}
              disabled={disabled === true || readOnly === true || atMin}
              // Keep focus in the box so a click does not run blur validation mid-adjustment.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepBy(-1)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M5 12h14" />
              </svg>
            </button>
            <button
              type="button"
              tabIndex={-1}
              className={styles.stepper}
              aria-label={`Increase ${spin.buttonNoun}`}
              disabled={disabled === true || readOnly === true || atMax}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => stepBy(1)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                aria-hidden="true"
                focusable="false"
              >
                <path d="M5 12h14" />
                <path d="M12 5v14" />
              </svg>
            </button>
          </span>
        ) : null}
      </div>
      {name ? (
        <input type="hidden" name={name} value={postedOf(text)} disabled={disabled === true} />
      ) : null}
      {wordsText ? (
        <span id={wordsId} className={styles.words}>
          {wordsText}
        </span>
      ) : null}
      {/* One polite region, always present so the first refusal is announced. */}
      <span
        id={statusId}
        role="status"
        className={styles.status}
        data-tone={!notice.text && error ? 'error' : undefined}
      >
        {status ? <span key={notice.text ? notice.seq : 'error'}>{status}</span> : null}
      </span>
    </div>
  );
}

function groupPlain(plain: string, system: NumberSystem | null): string {
  if (!system) return plain;
  const [whole = '0', fraction] = plain.split('.');
  const grouped = groupDigits(whole, system);
  return fraction === undefined ? grouped : `${grouped}.${fraction}`;
}

export interface MoneyInputProps extends NumberInputCommonProps {
  currency: Currency;
  /** Shows the amount in words under the box ("Twenty lakh ..."), read through aria-describedby. */
  showWords?: boolean | undefined;
  /** Fewer whole digits than the money default of 16, where the field's contract takes fewer. */
  intDigits?: number | undefined;
  /** Overrides the tenant's grouping for this currency. */
  numberSystem?: NumberSystem | undefined;
}

/**
 * An amount in one currency: 16 whole digits, 2 decimals, no negatives. Groups live in the
 * tenant's number system for the currency (`12,50,000` for NPR by default) and shows the currency
 * code inside the box. Pads to 2 decimals on blur and posts what it shows (`1250.00`).
 *
 *   <Field label="Amount">{(control) => <MoneyInput {...control} name="amount" currency="NPR" />}</Field>
 */
export function MoneyInput({
  currency,
  showWords,
  numberSystem,
  intDigits,
  ...rest
}: MoneyInputProps) {
  const systems = useNumberSystems();
  const system = numberSystem ?? systems[currency];
  const numberSystems: NumberSystems = { ...systems, [currency]: system };
  return (
    <NumberBox
      {...rest}
      limits={intDigits === undefined ? MONEY_LIMITS : { ...MONEY_LIMITS, intDigits }}
      grouping={system}
      prefix={currency}
      padTo={2}
      describe={(amount) => formatMoney(amount, currency, { numberSystems })}
      words={showWords ? (amount) => amountInWords(amount, currency, system) : undefined}
    />
  );
}

export interface QuantityInputProps extends NumberInputCommonProps {
  /** Unit shown inside the box after the number. */
  uom?: string | undefined;
  /** What the stepper buttons and arrow keys add or take away. Defaults to "1". */
  step?: string | undefined;
  /** The document currency, so quantities group like its amounts. Lakh style without one. */
  currency?: Currency | undefined;
}

/**
 * A quantity: 14 whole digits, 4 decimals. A spinbutton: Arrow Up/Down and the minus/plus buttons
 * step by `step`, exactly (0.1 + 0.2 is 0.3). Without a `min` it steps down to 0 but reports zero
 * on blur, because QuantityString needs more than zero; a caller `min` replaces that rule.
 */
export function QuantityInput({ uom, step = '1', currency, min, ...rest }: QuantityInputProps) {
  const systems = useNumberSystems();
  const system: NumberSystem = currency ? systems[currency] : 'south_asian';
  return (
    <NumberBox
      {...rest}
      min={min ?? '0'}
      positive={min === undefined}
      limits={QUANTITY_LIMITS}
      grouping={system}
      suffix={uom}
      describe={(quantity) => `${groupPlain(quantity, system)}${uom ? ` ${uom}` : ''}`}
      spin={{ step, buttonNoun: 'quantity' }}
    />
  );
}

export interface PercentInputProps extends NumberInputCommonProps {
  /** Decimals allowed. Defaults to 4, the contracts' limit. */
  scale?: 0 | 2 | 4 | undefined;
}

/** A percentage from 0 to 100 by default, with a `%` inside the box. Arrow Up/Down step by 1. */
export function PercentInput({ scale = 4, min = '0', max = '100', ...rest }: PercentInputProps) {
  return (
    <NumberBox
      {...rest}
      min={min}
      max={max}
      limits={{ intDigits: PERCENT_LIMITS.intDigits, scale }}
      grouping={null}
      suffix="%"
      describe={(percent) => `${percent}%`}
      spin={{ step: '1', buttonNoun: null }}
    />
  );
}

export interface DecimalInputProps extends NumberInputCommonProps {
  intDigits: number;
  scale: number;
}

/**
 * A plain number with the given digit limits and no grouping: an FX rate (12 + 6), a score, days,
 * hours. `scale={0}` makes a whole-number field with the numeric keyboard.
 */
export function DecimalInput({ intDigits, scale, ...rest }: DecimalInputProps) {
  return (
    <NumberBox
      {...rest}
      limits={{ intDigits, scale }}
      grouping={null}
      describe={(number) => number}
    />
  );
}
