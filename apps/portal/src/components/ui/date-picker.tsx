'use client';

// Copy of the workspace DatePicker (apps/workspace/src/components/ui/date-picker.tsx), as the portal's number inputs are.

import { getLocalTimeZone, isToday, parseDate, type CalendarDate } from '@internationalized/date';
import { bsLongOfDay } from '@bos/locale';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useInsertionEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from 'react';
import { flushSync } from 'react-dom';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateFieldStateContext,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
} from 'react-aria-components';

import { dropdownPopoverProps, usePopoverContainer } from './popover-container';
import { useFormReset } from './use-form-reset';
import styles from './date-picker.module.css';
import { useFieldSecondary, useInFieldScope } from '@/components/portal/field-scope';

/** `YYYY-MM-DD` to a calendar date, or null for an empty or malformed value. */
function toCalendarDate(iso: string | undefined | null): CalendarDate | null {
  if (!iso) return null;
  try {
    return parseDate(iso);
  } catch {
    return null;
  }
}

/** Drops undefined entries so optional props satisfy exactOptionalPropertyTypes. */
function defined<T extends object>(bag: T): { [K in keyof T]: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(bag).filter(([, v]) => v !== undefined)) as {
    [K in keyof T]: Exclude<T[K], undefined>;
  };
}

/**
 * Rendered inside the date field, where React Aria keeps its segment state. While a segment is
 * cleared, React Aria keeps the last complete date as its value, and posts it; this reports that
 * case, and the date the field holds, so the picker can post '' instead. `unfinished` is any partly
 * filled field, including one typed into from empty, which React Aria posts as ''.
 */
function CompletenessWatch({
  onChange,
}: {
  onChange: (incomplete: boolean, current: string, unfinished: boolean) => void;
}) {
  const state = useContext(DateFieldStateContext);
  const current = state?.value ? state.value.toString() : '';
  const editable = state?.segments.filter((segment) => segment.isEditable) ?? [];
  const someEmpty = editable.some((segment) => segment.isPlaceholder);
  const incomplete = current !== '' && someEmpty;
  const unfinished = someEmpty && (current !== '' || editable.some((s) => !s.isPlaceholder));
  useEffect(
    () => onChange(incomplete, current, unfinished),
    [incomplete, current, unfinished, onChange],
  );
  return null;
}

/**
 * State for the message an `UnfinishedBlocker` shows once it has blocked a submit. The message stays
 * until the field is finished; `shown` is false whenever the blocker is not mounted.
 */
export function useUnfinishedMessage(active: boolean) {
  const id = useId();
  const [blocked, setBlocked] = useState(false);
  if (blocked && !active) setBlocked(false);
  const onBlocked = useCallback(() => setBlocked(true), []);
  return { id, shown: blocked && active, onBlocked };
}

/**
 * Keeps a form from submitting a partly typed date, as a native date input does: through the
 * browser's own validation in a plain form, and by stopping the submit itself in a `noValidate`
 * form (`hold`, on unless a caller turns it off). Nameless, so it posts nothing. The browser cannot point at a hidden field, so its bubble is
 * cancelled: the message shows beside the field instead and the empty segment takes the focus.
 */
export function UnfinishedBlocker({
  message,
  root,
  disabled,
  messageId,
  shown,
  onBlocked,
  hold = true,
  native = true,
}: {
  hold?: boolean | undefined;
  /** Also let the browser's own validation block a plain form. Off for `validation="aria"`. */
  native?: boolean | undefined;
  message: string;
  root: RefObject<HTMLElement | null>;
  disabled?: boolean | undefined;
  messageId: string;
  shown: boolean;
  onBlocked: () => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useLayoutEffect(() => {
    ref.current?.setCustomValidity(native ? message : '');
  }, [message, native]);
  // A `noValidate` form (one that shows its own errors after a server action) never asks the browser
  // to validate, so the invalid event below would not come. `hold` stops the submit here instead: with
  // the action not running, the form is not reset, so the typed segments stay as they are. Stopped
  // before React's own submit handling, which would otherwise run the form's onSubmit and its action.
  useEffect(() => {
    const form = ref.current?.form;
    if (!hold || disabled === true || !form) return;
    const stop = (event: Event) => {
      // Another guard on the form (a digit box, a phone list) has already stopped this submit and
      // put the focus where its problem is; keep that focus and only show this message.
      const handled = event.defaultPrevented;
      event.preventDefault();
      event.stopPropagation();
      flushSync(onBlocked);
      if (!handled) root.current?.querySelector<HTMLElement>('[data-placeholder]')?.focus();
    };
    form.addEventListener('submit', stop);
    return () => form.removeEventListener('submit', stop);
  }, [hold, disabled, onBlocked, root]);
  return (
    <>
      <input
        ref={ref}
        type="text"
        hidden
        tabIndex={-1}
        aria-hidden="true"
        value=""
        disabled={disabled === true}
        onChange={() => {}}
        onInvalid={(event) => {
          event.preventDefault();
          // Committed first, so the segment is described by the message when it takes the focus.
          flushSync(onBlocked);
          root.current?.querySelector<HTMLElement>('[data-placeholder]')?.focus();
        }}
      />
      {shown ? (
        <span id={messageId} role="alert" className={styles.unfinished}>
          {message}
        </span>
      ) : null}
    </>
  );
}

export interface DatePickerProps {
  /** Id of the field group. `Field` passes its control id here. */
  id?: string | undefined;
  /** Form field name. A hidden input carries the ISO `YYYY-MM-DD` value, or '' while the date is incomplete. */
  name?: string | undefined;
  /** Controlled value, `YYYY-MM-DD`, or `''` for empty. */
  value?: string | undefined;
  /** Uncontrolled initial value, `YYYY-MM-DD`. */
  defaultValue?: string | undefined;
  /** Called with `YYYY-MM-DD`, or `''` when the date is cleared or incomplete. */
  onChange?: ((value: string) => void) | undefined;
  /** Earliest selectable date, `YYYY-MM-DD`. */
  min?: string | undefined;
  /** Latest selectable date, `YYYY-MM-DD`. */
  max?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  invalid?: boolean | undefined;
  /** What `Field` hands over, so a spread of its control props just works. */
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  /** Accessible name when there is no visible label. */
  'aria-label'?: string | undefined;
  className?: string | undefined;
  /** For an enclosing modal, keep the calendar inside its focus and stacking boundary. */
  popoverContainer?: HTMLElement | undefined;
  /** Show the Nepali (BS) date under the field. On by default; a filter row turns it off. */
  showBs?: boolean | undefined;
  /**
   * `native` (default): a required, empty or out-of-range picker blocks a plain GET or POST form in the
   * browser, as any native field does. `aria`: the browser does not block a required or incomplete
   * date; use it in an action form that shows its own errors for those.
   * In both, a partly typed date stops the submit of any form the browser does not already block
   * (a `noValidate` action form, or an `aria` one), so the action does not reset the form: the typed segments stay, "Finish the date" shows and the empty segment takes
   * the focus.
   */
  validation?: 'native' | 'aria' | undefined;
}

/**
 * Date picker: an accessible segmented date field plus a calendar popover, built on
 * react-aria-components and styled with the design tokens. Type the segments, use the arrow
 * keys, or open the calendar. The form value is always ISO `YYYY-MM-DD`, whatever the display
 * locale, through a hidden native date input named `name` (so plain `<form action>` and
 * FormData work, and native `required` applies).
 *
 *   <Field label="Applies from">
 *     {(control) => <DatePicker {...control} name="rateDate" defaultValue="2026-11-18" required />}
 *   </Field>
 *
 * Controlled: `value` + `onChange(iso)`. Uncontrolled: `defaultValue`.
 *
 * The Bikram Sambat date of the chosen day is shown under the field (`04 Poush 2083 BS`, from
 * `@bos/locale`) and tied to the field with `aria-describedby`, so a screen reader hears it with
 * the date. `className` styles the wrapper that holds the field and that line.
 */
export function DatePicker({
  id,
  name,
  value,
  defaultValue,
  onChange,
  min,
  max,
  disabled,
  readOnly,
  required,
  invalid,
  'aria-invalid': ariaInvalid,
  className,
  popoverContainer,
  showBs = true,
  validation = 'native',
  ...aria
}: DatePickerProps) {
  const bsId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [typed, setTyped] = useState(defaultValue ?? '');
  const [incomplete, setIncomplete] = useState(false);
  const [unfinished, setUnfinished] = useState(false);
  // The date React Aria still holds while the field is incomplete. A controlled parent hears '' and
  // passes '' back; React Aria keeps getting this date, or it would wipe the segments still filled.
  const [held, setHeld] = useState<string | null>(null);
  const heldRef = useRef<string | null>(null);
  // Bumped when a held date is picked again, so React Aria gets a new object and refills the segments.
  const [refills, setRefills] = useState(0);
  const hold = useCallback((date: string | null) => {
    heldRef.current = date;
    setHeld(date);
  }, []);
  const latestOnChange = useRef(onChange);
  useInsertionEffect(() => {
    latestOnChange.current = onChange;
  });
  // React 19 resets a form after every function action, and React Aria then reports the reset as a
  // change to a controlled picker, which would wipe what the user chose. A reset restores the
  // default of an uncontrolled picker; a controlled parent keeps its own value. An incomplete
  // controlled date posted '' and its parent holds ''; dropping the held date shows that, where
  // React Aria would refill the segments from the held date and post it.
  const isResetting = useFormReset(rootRef, () => {
    setTyped(defaultValue ?? '');
    hold(null);
  });
  const watchCompleteness = useCallback(
    (nowIncomplete: boolean, current: string, nowUnfinished: boolean) => {
      const was = heldRef.current;
      hold(nowIncomplete ? current : null);
      setIncomplete(nowIncomplete);
      setUnfinished(nowUnfinished);
      if (nowIncomplete && was === null) latestOnChange.current?.('');
      // Retyping the date React Aria already holds completes the field without a change event.
      else if (!nowIncomplete && was !== null) latestOnChange.current?.(current);
    },
    [hold],
  );
  const chosen = incomplete ? '' : value !== undefined ? value : typed;
  const fed = value === '' && held !== null ? held : value;
  // React Aria resets the segments whenever it gets a new date object, so keep one per date.
  // eslint-disable-next-line react-hooks/exhaustive-deps -- `refills` forces a new object.
  const fedDate = useMemo(() => toCalendarDate(fed), [fed, refills]);
  const bsText = showBs ? bsLongOfDay(chosen) : null;
  // Inside a Field the BS date goes in the field's one message line (UIP-FORM-010); alone it prints its own.
  const inField = useInFieldScope(id);
  useFieldSecondary(id, bsText);
  const bs = inField ? null : bsText;
  const unfinishedMessage = useUnfinishedMessage(unfinished);
  const describedBy =
    [
      aria['aria-describedby'],
      unfinishedMessage.shown ? unfinishedMessage.id : undefined,
      bs ? bsId : undefined,
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  // `Field` names the picker with a `<label for>`, but the id lands on React Aria's group, which a
  // label cannot focus. A click on that label focuses the first segment, as React Aria's own label does.
  useEffect(() => {
    if (id === undefined || disabled === true) return;
    const doc = rootRef.current?.ownerDocument;
    if (!doc) return;
    const onLabelClick = (event: MouseEvent) => {
      const label = event.target instanceof Element ? event.target.closest('label') : null;
      if (label?.htmlFor !== id) return;
      rootRef.current?.querySelector<HTMLElement>('[role="spinbutton"], [role="textbox"]')?.focus();
    };
    doc.addEventListener('click', onLabelClick);
    return () => doc.removeEventListener('click', onLabelClick);
  }, [id, disabled]);
  const contextContainer = usePopoverContainer();
  const container = popoverContainer ?? contextContainer;
  const isInvalid =
    invalid === true || ariaInvalid === true || ariaInvalid === 'true' || unfinishedMessage.shown;
  const minValue = toCalendarDate(min);
  const maxValue = toCalendarDate(max);
  const optional = defined({
    id,
    name: incomplete ? undefined : name,
    isDisabled: disabled,
    isReadOnly: readOnly,
    isRequired: required,
    isInvalid: isInvalid || undefined,
    'aria-labelledby': aria['aria-labelledby'],
    'aria-describedby': describedBy,
    'aria-label': aria['aria-label'],
    ...(value !== undefined ? { value: fedDate } : { defaultValue: toCalendarDate(defaultValue) }),
  });

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <AriaDatePicker
        {...optional}
        validationBehavior={validation === 'aria' ? 'aria' : 'native'}
        onChange={(next) => {
          if (isResetting()) return;
          const iso = next ? next.toString() : '';
          if (heldRef.current !== null) setRefills((n) => n + 1);
          hold(null);
          setTyped(iso);
          onChange?.(iso);
        }}
        minValue={minValue}
        maxValue={maxValue}
        className={styles.picker ?? ''}
      >
        <Group className={styles.group ?? ''}>
          <DateInput className={styles.input ?? ''}>
            {(segment) =>
              segment.type === 'year' ? (
                <>
                  <DateSegment segment={segment} className={styles.segment ?? ''} />
                  <CompletenessWatch onChange={watchCompleteness} />
                </>
              ) : (
                <DateSegment segment={segment} className={styles.segment ?? ''} />
              )
            }
          </DateInput>
          <Button className={styles.trigger ?? ''}>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              width="20"
              height="20"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
              focusable="false"
            >
              <path d="M8 2v4" />
              <path d="M16 2v4" />
              <rect width="18" height="18" x="3" y="4" rx="2" />
              <path d="M3 10h18" />
            </svg>
          </Button>
        </Group>
        <Popover className={styles.popover ?? ''} {...dropdownPopoverProps(container)}>
          <Dialog className={styles.dialog ?? ''}>
            <Calendar className={styles.calendar ?? ''}>
              <header className={styles.calendarHeader ?? ''}>
                <Button slot="previous" className={styles.nav ?? ''}>
                  <svg
                    className={styles.prevIcon ?? ''}
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </Button>
                <Heading className={styles.heading ?? ''} />
                <Button slot="next" className={styles.nav ?? ''}>
                  <svg
                    xmlns="http://www.w3.org/2000/svg"
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    aria-hidden="true"
                    focusable="false"
                  >
                    <path d="m9 18 6-6-6-6" />
                  </svg>
                </Button>
              </header>
              <CalendarGrid className={styles.grid ?? ''}>
                <CalendarGridHeader>
                  {(day) => (
                    <CalendarHeaderCell className={styles.weekday ?? ''}>{day}</CalendarHeaderCell>
                  )}
                </CalendarGridHeader>
                <CalendarGridBody>
                  {(date) => (
                    <CalendarCell
                      date={date}
                      className={[
                        styles.cell,
                        isToday(date, getLocalTimeZone()) ? styles.today : '',
                      ]
                        .filter(Boolean)
                        .join(' ')}
                    />
                  )}
                </CalendarGridBody>
              </CalendarGrid>
            </Calendar>
          </Dialog>
        </Popover>
      </AriaDatePicker>
      {incomplete && name !== undefined ? (
        <input type="hidden" name={name} value="" disabled={disabled} />
      ) : null}
      {unfinished ? (
        <UnfinishedBlocker
          native={validation !== 'aria'}
          message="Finish the date"
          root={rootRef}
          disabled={disabled}
          messageId={unfinishedMessage.id}
          shown={unfinishedMessage.shown}
          onBlocked={unfinishedMessage.onBlocked}
        />
      ) : null}
      {bs ? (
        <span id={bsId} className={styles.bs}>
          {bs}
        </span>
      ) : null}
    </div>
  );
}
