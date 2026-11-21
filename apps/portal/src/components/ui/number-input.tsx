'use client';

// Copy of the workspace number inputs (apps/workspace/src/components/ui/number-input.tsx). The portal
// has no tenant number-system context: grouping comes from the `numberSystems` prop, which views
// take from `PortalDisplay`. Keep the two copies in step.

import { MONEY_LIMITS, PERCENT_LIMITS, QUANTITY_LIMITS } from '@bos/contracts';
import {
  amountInWords,
  Dec,
  DEFAULT_NUMBER_SYSTEMS,
  fitsWhileTyping,
  formatMoney,
  groupDigits,
  normalisePastedNumber,
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
  type ClipboardEvent,
  type DragEvent,
  type KeyboardEvent,
  type MouseEvent,
} from 'react';
import {
  NumericFormat,
  numericFormatter,
  type NumberFormatValues,
  type SourceInfo,
} from 'react-number-format';

import { useFormReset } from './use-form-reset';
import styles from './number-input.module.css';

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
  /** Called with the plain decimal string whenever the entered number changes. */
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
  /** Decimals the display pads to while the user is not editing. The posted value is never padded. */
  padTo?: number | undefined;
  /** How a bound reads in a refusal: `NPR 20,18,180.00`, `100%`. */
  describe: (plain: string) => string;
  spin?: Spin | undefined;
  words?: ((plain: string) => string) | undefined;
}

/**
 * What a numeric string means as a finished value: `007` is `7`, `.5` is `0.5`, `12.` is `12`, `.` is
 * empty. Zero-only decimals past the field's scale are dropped (`12.5000` is `12.50` in a 2-decimal
 * field), because the server sends numeric columns at full scale. Anything else outside the limits
 * is empty.
 */
function normalise(raw: string, limits: NumberLimits): string {
  if (raw === '') return '';
  const [whole = '', fraction] = raw.split('.');
  let text = raw;
  if (fraction !== undefined && fraction.length > limits.scale) {
    if (/^0*$/.test(fraction.slice(limits.scale))) {
      const kept = fraction.slice(0, limits.scale);
      text = kept === '' ? whole : `${whole}.${kept}`;
    }
  }
  const check = withinLimits(text, limits);
  return check.ok ? check.value : '';
}

const isDecimal = (text: string) => /^(\d+\.?\d*|\.\d+)$/.test(text);

/** Equal as numbers (`1.0` and `1`), so a parent that canonicalises its copy does not erase typing. */
function sameNumber(a: string, b: string): boolean {
  if (a === b) return true;
  return isDecimal(a) && isDecimal(b) && new Dec(a).eq(new Dec(b));
}

/** Why typed or inserted text is refused before it reaches the formatter, or null when it may go in. */
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

// Desktop Backspace moves the caret off a separator in keydown (the library does it) and the
// browser then deletes the digit. Android sends keydown "Unidentified", so the browser would delete
// the separator itself and the formatter would put it straight back. Delete the digit instead.
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
  // `raw` is the library's own numeric string, which may be unfinished (`12.`, `007`). Feeding it the
  // normalised value instead would erase a point the user has just typed.
  const [raw, setRaw] = useState(() => (controlled ? value : (defaultValue ?? '')));
  const [padded, setPadded] = useState(padTo !== undefined);
  // `seq` changes on every refusal so a repeated message is a new DOM node and is announced again.
  const [notice, setNotice] = useState({ text: '', seq: 0 });
  const [error, setError] = useState('');

  // A controlled parent that set a different number wins over what was being typed.
  const current = controlled && !sameNumber(normalise(raw, limits), value) ? value : raw;
  const plain = normalise(current, limits);
  // A server value outside this field's limits (`12.5555` in a 2-decimal field) is posted as given
  // until the user edits it, so an untouched field never sends an empty string in its place.
  const posted = plain === '' && current !== '.' ? current : plain;

  // Handlers may run twice in one event (the library's blur reports a change, then calls onBlur), so
  // they read and write these refs rather than state from the last render.
  const rawRef = useRef(current);
  const emitted = useRef(plain);
  const edited = useRef(false);
  useLayoutEffect(() => {
    rawRef.current = current;
    emitted.current = plain;
  }, [current, plain]);

  const bounds = {
    min: min === undefined || min === '' ? undefined : describe(min),
    max: max === undefined || max === '' ? undefined : describe(max),
  };
  const rawBounds = { min: bounds.min && min, max: bounds.max && max };

  const shownValue =
    padded && padTo !== undefined && plain !== '' ? new Dec(plain).toFixed(padTo) : current;
  const formatOptions = {
    thousandSeparator: grouping ? ',' : false,
    thousandsGroupStyle: grouping === 'international' ? ('thousand' as const) : ('lakh' as const),
    decimalSeparator: '.',
    allowNegative: false,
  };

  function commit(nextRaw: string) {
    rawRef.current = nextRaw;
    setRaw(nextRaw);
    const nextPlain = normalise(nextRaw, limits);
    if (nextPlain !== emitted.current) {
      emitted.current = nextPlain;
      onValueChange?.(nextPlain);
    }
  }

  function refuse(reason: NumberRefusal) {
    const text = refusalMessage(reason, limits, bounds);
    setNotice((last) => ({ text, seq: last.seq + 1 }));
  }

  function clearNotice() {
    setNotice((last) => (last.text === '' ? last : { text: '', seq: last.seq }));
  }

  /** The blur-time message for the text as posted, or '' when it is acceptable. */
  function validate(text: string): string {
    if (text === '') return required ? refusalMessage('empty', limits) : '';
    const check = withinLimits(normalise(text, limits) || text, limits, rawBounds);
    return check.ok ? '' : refusalMessage(check.reason, limits, bounds);
  }

  function accept(nextRaw: string) {
    edited.current = true;
    setPadded(false);
    clearNotice();
    commit(nextRaw);
    // Mid-typing a value passes through states below min (5 on the way to 50), so an error shown at
    // blur is only cleared here, never replaced; the next blur checks again.
    if (error && validate(normalise(nextRaw, limits)) === '') setError('');
  }

  const isResetting = useFormReset(rootRef, () => {
    clearNotice();
    setError('');
    setPadded(padTo !== undefined);
    edited.current = false;
    // A controlled parent owns the value; reporting the reset to it would undo its state.
    if (controlled) return;
    commit(defaultValue ?? '');
  });

  // Soft keyboards often send keydown with key "Unidentified", so the inserted text is checked again
  // here. React's onBeforeInput is a polyfill over other events, hence the native listener.
  const onNativeBeforeInput = useEffectEvent((event: Event) => {
    const { inputType, data } = event as InputEvent;
    const input = inputRef.current;
    if (!input || !inputType) return;
    if (inputType === 'deleteContentBackward' || inputType === 'deleteContentForward') {
      deleteAcrossSeparator(event, input, inputType === 'deleteContentBackward');
      return;
    }
    if (!inputType.startsWith('insert') || inputType === 'insertFromPaste' || !data) return;
    const reason = refusedText(data, limits.scale, pointOutsideSelection(input));
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

  /** The number to step from: the value as posted, so a server value outside the limits still counts. */
  function stepBase(): Dec {
    if (plain !== '') return new Dec(plain);
    return isDecimal(posted) ? new Dec(posted) : new Dec(0);
  }
  const atMin = min !== undefined && min !== '' && stepBase().lte(new Dec(min));
  const atMax = max !== undefined && max !== '' && stepBase().gte(new Dec(max));

  function stepBy(direction: 1 | -1) {
    if (!spin || disabled || readOnly) return;
    let next = stepBase().plus(new Dec(spin.step).times(direction));
    if (min !== undefined && min !== '' && next.lt(new Dec(min))) next = new Dec(min);
    if (max !== undefined && max !== '' && next.gt(new Dec(max))) next = new Dec(max);
    const check = withinLimits(next.toDecimalPlaces(limits.scale).toFixed(), limits);
    if (!check.ok) {
      refuse(check.reason);
      return;
    }
    accept(check.value);
  }

  // Text that reached the box without a cancellable keystroke (autofill, a drop, an IME commit) is
  // judged here, before the formatter drops characters it does not know and turns `1,5` into 15.
  // The box's raw text is compared with what it showed; separators already there are not "inserted".
  function insertedRefusal(): NumberRefusal | null {
    const input = inputRef.current;
    if (!input) return null;
    const text = input.value;
    const before = numericFormatter(shownValue, formatOptions);
    if (text === before) return null;
    let head = 0;
    while (head < text.length && head < before.length && text[head] === before[head]) head += 1;
    let tail = 0;
    while (
      tail < text.length - head &&
      tail < before.length - head &&
      text[text.length - 1 - tail] === before[before.length - 1 - tail]
    ) {
      tail += 1;
    }
    const inserted = text.slice(head, text.length - tail);
    if (inserted === '') return null;
    if (before === '' || head + tail === 0) {
      // A whole new text: digits and one point may be unfinished (`.`); anything else must be a
      // validly grouped number, as for a paste.
      if (refusedText(text, limits.scale, false) === null) return null;
      const check = normalisePastedNumber(text, limits);
      return check.ok ? null : check.reason;
    }
    const kept = text.slice(0, head) + text.slice(text.length - tail);
    return refusedText(inserted, limits.scale, kept.includes('.'));
  }

  // The library refuses a change when this returns false and restores the old text and caret.
  // No decimalScale is passed while typing: the library would trim a third decimal silently before
  // this check ran, and the refusal would have no status line.
  function isAllowed({ value: next }: NumberFormatValues): boolean {
    const inserted = insertedRefusal();
    if (inserted) {
      refuse(inserted);
      return false;
    }
    if (!fitsWhileTyping(next, limits)) {
      const fraction = next.split('.')[1] ?? '';
      refuse(fraction.length > limits.scale ? 'too_many_decimals' : 'too_many_digits');
      return false;
    }
    const normal = normalise(next, limits);
    if (max !== undefined && max !== '' && normal !== '' && new Dec(normal).gt(new Dec(max))) {
      refuse('above_max');
      return false;
    }
    return true;
  }

  // Editing a padded display (`100.00`) leaves the padding in the edited text; the padding is display
  // only, so it comes off again and `9100.00` posts as 9100.
  function withoutPadding(next: string): string {
    if (!padded || padTo === undefined || plain === '') return next;
    const padding = new Dec(plain).toFixed(padTo).slice(current.length);
    return padding !== '' && next.endsWith(padding) ? next.slice(0, -padding.length) : next;
  }

  function onLibraryChange(values: NumberFormatValues, info: SourceInfo) {
    // Only the user's edits count. The library also reports values it derived from props (padding,
    // a reset), which must never reach the hidden input or the parent. Those come without an event;
    // its SourceType enum is not exported, so the event is the check.
    if (info.event === undefined || isResetting()) return;
    accept(withoutPadding(values.value));
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (spin && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
      event.preventDefault();
      stepBy(event.key === 'ArrowUp' ? 1 : -1);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey || event.key.length !== 1) return;
    const reason = refusedText(event.key, limits.scale, pointOutsideSelection(event.currentTarget));
    if (reason) {
      event.preventDefault();
      refuse(reason);
    }
  }

  // Raw clipboard or dropped text never reaches the formatter: it drops characters it does not know,
  // which would turn `1,5` into 15. An empty box or a full selection is replaced; otherwise the text
  // goes in at the caret or over the selection, as a browser would, and the whole result is judged.
  function insertText(text: string, input: HTMLInputElement, start: number, end: number) {
    if (disabled || readOnly) return;
    const shown = input.value;
    const replaceAll = shown === '' || (start === 0 && end === shown.length);
    let check: NumberCheck;
    if (replaceAll) {
      check = normalisePastedNumber(text, limits, rawBounds);
    } else {
      const piece = text.trim();
      let pieceValue = piece;
      if (!/^\d*\.?\d*$/.test(piece)) {
        const pieceCheck = normalisePastedNumber(piece, limits);
        if (!pieceCheck.ok) {
          refuse(pieceCheck.reason);
          return;
        }
        pieceValue = pieceCheck.value;
      }
      const ungroup = (part: string) => part.replaceAll(',', '');
      const combined = ungroup(shown.slice(0, start)) + pieceValue + ungroup(shown.slice(end));
      check = withinLimits(combined, limits, rawBounds);
    }
    if (!check.ok) {
      refuse(check.reason);
      return;
    }
    accept(replaceAll ? check.value : withoutPadding(check.value));
  }

  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    const input = event.currentTarget;
    const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    const start = input.selectionStart ?? input.value.length;
    insertText(text, input, start, input.selectionEnd ?? start);
  }

  // The drop point is not known here, so a drop replaces the whole value.
  function onDrop(event: DragEvent<HTMLInputElement>) {
    event.preventDefault();
    const input = event.currentTarget;
    input.focus();
    const text = event.dataTransfer.getData('text/plain') || event.dataTransfer.getData('text');
    insertText(text, input, 0, input.value.length);
  }

  function onBlur() {
    const typed = rawRef.current;
    const normal = normalise(typed, limits);
    // Only the user's own text is tidied (`007`, `12.`); a server value is left as sent, and a value
    // that cannot be tidied is kept and reported rather than replaced with nothing.
    if (edited.current && normal !== typed && (normal !== '' || typed === '.')) commit(normal);
    edited.current = false;
    clearNotice();
    setError(validate(normal !== '' || typed === '.' ? normal : typed));
    if (padTo !== undefined) setPadded(true);
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

  const wordsText = words && plain !== '' ? words(plain) : '';
  const status = notice.text || error;
  const invalid = callerInvalid === true || callerInvalid === 'true' || error !== '';
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
        <NumericFormat
          getInputRef={inputRef}
          className={styles.input}
          type="text"
          inputMode={limits.scale === 0 ? 'numeric' : 'decimal'}
          autoComplete="off"
          valueIsNumericString
          value={shownValue}
          {...formatOptions}
          allowedDecimalSeparators={['.']}
          isAllowed={isAllowed}
          onValueChange={onLibraryChange}
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
                ...(min === undefined || min === '' ? {} : { 'aria-valuemin': Number(min) }),
                ...(max === undefined || max === '' ? {} : { 'aria-valuemax': Number(max) }),
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
        <input type="hidden" name={name} value={posted} disabled={disabled === true} />
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
  /** Overrides the selling company's grouping for this currency. */
  numberSystem?: NumberSystem | undefined;
  /** The selling company's grouping per currency, from `PortalDisplay.numberSystems`. */
  numberSystems?: NumberSystems | undefined;
}

/**
 * An amount in one currency: 16 whole digits, 2 decimals, no negatives. Groups live in the
 * selling company's number system for the currency (`12,50,000` for NPR by default) and shows the currency
 * code inside the box. Pads to 2 decimals while not being edited; the posted value is unpadded.
 *
 *   <Field label="Amount">{(control) => <MoneyInput {...control} name="amount" currency="NPR" />}</Field>
 */
export function MoneyInput({
  currency,
  showWords,
  numberSystem,
  numberSystems: systems = DEFAULT_NUMBER_SYSTEMS,
  ...rest
}: MoneyInputProps) {
  const system = numberSystem ?? systems[currency];
  const numberSystems: NumberSystems = { ...systems, [currency]: system };
  return (
    <NumberBox
      {...rest}
      limits={MONEY_LIMITS}
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
  /** The selling company's grouping per currency, from `PortalDisplay.numberSystems`. */
  numberSystems?: NumberSystems | undefined;
}

/**
 * A quantity: 14 whole digits, 4 decimals, minimum 0 unless `min` says otherwise. A spinbutton:
 * Arrow Up/Down and the minus/plus buttons step by `step`, exactly (0.1 + 0.2 is 0.3).
 */
export function QuantityInput({
  uom,
  step = '1',
  currency,
  min = '0',
  numberSystems: systems = DEFAULT_NUMBER_SYSTEMS,
  ...rest
}: QuantityInputProps) {
  const system: NumberSystem = currency ? systems[currency] : 'south_asian';
  return (
    <NumberBox
      {...rest}
      min={min}
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
