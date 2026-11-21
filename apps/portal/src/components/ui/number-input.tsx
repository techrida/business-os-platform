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
  type KeyboardEvent,
} from 'react';
import { NumericFormat, type NumberFormatValues, type SourceInfo } from 'react-number-format';

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

/** What the library's raw string means as a finished value: `007` is `7`, `.5` is `0.5`, `12.` is `12`, `.` is empty. */
function normalise(raw: string, limits: NumberLimits): string {
  if (raw === '') return '';
  const check = withinLimits(raw, limits);
  return check.ok ? check.value : '';
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
  const wordsId = `${base}-words`;
  const statusId = `${base}-status`;
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const controlled = value !== undefined;
  // `raw` is the library's own numeric string, which may be unfinished (`12.`, `007`). Feeding it the
  // normalised value instead would erase a point the user has just typed.
  const [raw, setRaw] = useState(() => (controlled ? value : (defaultValue ?? '')));
  const [padded, setPadded] = useState(padTo !== undefined);
  const [notice, setNotice] = useState('');
  const [error, setError] = useState('');

  // A controlled parent that set a different number wins over what was being typed.
  const current = controlled && normalise(raw, limits) !== value ? value : raw;
  const plain = normalise(current, limits);
  // A server value outside this field's limits (`13.0000` in a 2-decimal field) is posted as given
  // until the user edits it, so an untouched field never sends an empty string in its place.
  const posted = plain === '' && current !== '.' ? current : plain;

  // Handlers may run twice in one event (the library's blur reports a change, then calls onBlur), so
  // they read and write these refs rather than state from the last render.
  const rawRef = useRef(current);
  const emitted = useRef(plain);
  useLayoutEffect(() => {
    rawRef.current = current;
    emitted.current = plain;
  }, [current, plain]);

  const bounds = {
    min: min === undefined || min === '' ? undefined : describe(min),
    max: max === undefined || max === '' ? undefined : describe(max),
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
    setNotice(refusalMessage(reason, limits, bounds));
  }

  function validate(next: string): string {
    if (next === '') return required ? refusalMessage('empty', limits) : '';
    const number = new Dec(next);
    if (bounds.min !== undefined && number.lt(new Dec(min!))) {
      return refusalMessage('below_min', limits, bounds);
    }
    if (bounds.max !== undefined && number.gt(new Dec(max!))) {
      return refusalMessage('above_max', limits, bounds);
    }
    return '';
  }

  function accept(nextRaw: string) {
    setPadded(false);
    setNotice('');
    commit(nextRaw);
    if (error) setError(validate(normalise(nextRaw, limits)));
  }

  const isResetting = useFormReset(rootRef, () => {
    setNotice('');
    setError('');
    setPadded(padTo !== undefined);
    // A controlled parent owns the value; reporting the reset to it would undo its state.
    if (controlled) return;
    commit(defaultValue ?? '');
  });

  // Soft keyboards often send keydown with key "Unidentified", so the inserted text is checked again
  // here. React's onBeforeInput is a polyfill over other events, hence the native listener.
  const onNativeBeforeInput = useEffectEvent((event: Event) => {
    const { inputType, data } = event as InputEvent;
    if (!inputType?.startsWith('insert') || inputType === 'insertFromPaste' || !data) return;
    const input = inputRef.current;
    if (!input) return;
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

  function stepBy(direction: 1 | -1) {
    if (!spin || disabled || readOnly) return;
    let next = (plain === '' ? new Dec(0) : new Dec(plain)).plus(
      new Dec(spin.step).times(direction),
    );
    if (min !== undefined && min !== '' && next.lt(new Dec(min))) next = new Dec(min);
    if (max !== undefined && max !== '' && next.gt(new Dec(max))) next = new Dec(max);
    accept(next.toDecimalPlaces(limits.scale).toFixed());
  }

  // The library refuses a change when this returns false and restores the old text and caret.
  // No decimalScale is passed while typing: the library would trim a third decimal silently before
  // this check ran, and the refusal would have no status line.
  function isAllowed({ value: next }: NumberFormatValues): boolean {
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

  function onLibraryChange(values: NumberFormatValues, info: SourceInfo) {
    // Only the user's edits count. The library also reports values it derived from props (padding,
    // a reset), which must never reach the hidden input or the parent. Those come without an event;
    // its SourceType enum is not exported, so the event is the check.
    if (info.event === undefined || isResetting()) return;
    accept(values.value);
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

  // Raw clipboard text never reaches the formatter: it drops characters it does not know, which
  // would turn `1,5` into 15.
  function onPaste(event: ClipboardEvent<HTMLInputElement>) {
    event.preventDefault();
    if (disabled || readOnly) return;
    const text = event.clipboardData.getData('text/plain') || event.clipboardData.getData('text');
    const input = event.currentTarget;
    const shown = input.value;
    const start = input.selectionStart ?? shown.length;
    const end = input.selectionEnd ?? start;
    const partial = start !== end && !(start === 0 && end === shown.length);
    const pasteBounds = { max: max === '' ? undefined : max };
    let check: NumberCheck;
    if (partial) {
      // Replace only the selected span, then judge the whole result.
      const piece = text.trim();
      let pieceValue = piece;
      if (!/^\d*\.?\d*$/.test(piece)) {
        const pieceCheck = normalisePastedNumber(piece, {
          intDigits: limits.intDigits,
          scale: limits.scale,
        });
        if (!pieceCheck.ok) {
          refuse(pieceCheck.reason);
          return;
        }
        pieceValue = pieceCheck.value;
      }
      const ungroup = (part: string) => part.replaceAll(',', '');
      const combined = ungroup(shown.slice(0, start)) + pieceValue + ungroup(shown.slice(end));
      check = withinLimits(combined, limits, pasteBounds);
    } else {
      check = normalisePastedNumber(text, limits, pasteBounds);
    }
    if (!check.ok) {
      refuse(check.reason);
      return;
    }
    accept(check.value);
  }

  function onBlur() {
    const normal = normalise(rawRef.current, limits);
    if (normal !== rawRef.current) commit(normal);
    setNotice('');
    setError(validate(normal));
    if (padTo !== undefined) setPadded(true);
  }

  const shownValue =
    padded && padTo !== undefined && plain !== '' ? new Dec(plain).toFixed(padTo) : current;
  const wordsText = words && plain !== '' ? words(plain) : '';
  const status = error || notice;
  const invalid = callerInvalid === true || callerInvalid === 'true' || error !== '';
  const describedBy =
    [
      prefix ? prefixId : undefined,
      callerDescribedBy,
      wordsText ? wordsId : undefined,
      status ? statusId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const groupedText =
    plain === ''
      ? undefined
      : `${shownValue}${suffix ? (suffix === '%' ? '%' : ` ${suffix}`) : ''}`;

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <div className={styles.box} data-invalid={invalid || undefined}>
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
          thousandSeparator={grouping ? ',' : false}
          thousandsGroupStyle={grouping === 'international' ? 'thousand' : 'lakh'}
          decimalSeparator="."
          allowedDecimalSeparators={['.']}
          allowNegative={false}
          isAllowed={isAllowed}
          onValueChange={onLibraryChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
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
                ...(plain === '' ? {} : { 'aria-valuenow': Number(plain) }),
                ...(min === undefined || min === '' ? {} : { 'aria-valuemin': Number(min) }),
                ...(max === undefined || max === '' ? {} : { 'aria-valuemax': Number(max) }),
                ...(groupedText === undefined ? {} : { 'aria-valuetext': groupedText }),
              }
            : {})}
          required={required === true}
          disabled={disabled === true}
          readOnly={readOnly === true}
        />
        {suffix ? (
          <span className={styles.affix} aria-hidden="true">
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
              disabled={disabled === true || readOnly === true}
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
              disabled={disabled === true || readOnly === true}
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
        data-tone={error ? 'error' : undefined}
      >
        {status}
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
