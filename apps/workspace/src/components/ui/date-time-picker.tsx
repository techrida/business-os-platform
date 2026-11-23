'use client';

import { Time, parseTime } from '@internationalized/date';
import {
  DateInput,
  DateSegment,
  Group,
  TimeField,
  TimeFieldStateContext,
} from 'react-aria-components';
import {
  useCallback,
  useContext,
  useEffect,
  useId,
  useInsertionEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DatePicker, UnfinishedBlocker, useUnfinishedMessage } from './date-picker';
import pickerStyles from './date-picker.module.css';
import { useFormReset } from './use-form-reset';
import styles from './date-time-picker.module.css';

/** `YYYY-MM-DDTHH:mm` split into its day and its time, or two empty strings. */
function split(value: string | undefined): [string, string] {
  const match = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value ?? '');
  return match ? [match[1]!, match[2]!] : ['', ''];
}

const compose = (day: string, time: string) => (day !== '' && time !== '' ? `${day}T${time}` : '');

function toTime(text: string): Time | null {
  if (text === '') return null;
  try {
    return parseTime(text);
  } catch {
    return null;
  }
}

const pad = (n: number) => String(n).padStart(2, '0');

/**
 * Rendered inside the time field. While a time segment is cleared, React Aria keeps the last
 * complete time as its value; this reports that case and the time it holds, as the DatePicker's
 * watch does for the day.
 */
function TimeCompletenessWatch({
  onChange,
}: {
  onChange: (incomplete: boolean, current: string) => void;
}) {
  const state = useContext(TimeFieldStateContext);
  const held = state?.value;
  const current = held && 'hour' in held ? `${pad(held.hour)}:${pad(held.minute)}` : '';
  const incomplete =
    current !== '' &&
    (state?.segments.some((segment) => segment.isEditable && segment.isPlaceholder) ?? false);
  useEffect(() => onChange(incomplete, current), [incomplete, current, onChange]);
  return null;
}

export interface DateTimePickerProps {
  /** Id of the date field. `Field` passes its control id here. */
  id?: string | undefined;
  /** Form field name. A hidden input carries `YYYY-MM-DDTHH:mm`, the form a native datetime-local posted. */
  name?: string | undefined;
  /** Controlled value, `YYYY-MM-DDTHH:mm`, or `''` while the date or the time is missing. */
  value?: string | undefined;
  /** Uncontrolled initial value. */
  defaultValue?: string | undefined;
  /** Called with `YYYY-MM-DDTHH:mm`, or `''` until both the day and the time are set. */
  onChange?: ((value: string) => void) | undefined;
  min?: string | undefined;
  max?: string | undefined;
  disabled?: boolean | undefined;
  readOnly?: boolean | undefined;
  required?: boolean | undefined;
  invalid?: boolean | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  'aria-label'?: string | undefined;
  className?: string | undefined;
  popoverContainer?: HTMLElement | undefined;
  /** Show the Nepali (BS) date under the day. On by default. */
  showBs?: boolean | undefined;
}

/**
 * The app's date-and-time control, in place of a native `datetime-local` input: the shared
 * `DatePicker` for the day (with its Bikram Sambat line) and an accessible time field beside it.
 * The value is `YYYY-MM-DDTHH:mm`, the same string the native input posted, so a form's reader needs
 * no change. The time is wall-clock time in whatever zone the caller means (the follow-up
 * dialogs say "Kathmandu time" in their hint).
 *
 *   <Field label="Due" hint="Kathmandu time.">
 *     {(control) => <DateTimePicker {...control} name="dueAt" required />}
 *   </Field>
 */
export function DateTimePicker({
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
  'aria-labelledby': labelledBy,
  'aria-describedby': callerDescribedBy,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
  className,
  popoverContainer,
  showBs,
}: DateTimePickerProps) {
  const timeId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState(() => split(value ?? defaultValue));
  // True while a time segment is cleared: the time field still shows the rest of `time`, but the
  // picker posts '' and tells the parent ''.
  const [timeIncomplete, setTimeIncomplete] = useState(false);
  const timeIncompleteRef = useRef(false);
  const markTimeIncomplete = useCallback((next: boolean) => {
    timeIncompleteRef.current = next;
    setTimeIncomplete(next);
  }, []);
  // A form reset after a function action must not wipe a controlled value (see DatePicker). A time
  // left incomplete posted '', so it shows empty, as the DatePicker does with an incomplete day.
  const isResetting = useFormReset(rootRef, () => {
    if (value === undefined) setParts(split(defaultValue));
    else if (timeIncompleteRef.current) setParts(([keptDay]) => [keptDay, '']);
    markTimeIncomplete(false);
  });
  const [day, time] = parts;
  const shownTime = timeIncomplete ? '' : time;
  const posted = compose(day, shownTime);
  // React Aria resets the segments whenever it gets a new time object, so keep one per time.
  const fedTime = useMemo(() => toTime(time), [time]);

  // A controlled parent that holds another value wins. A partly filled box reports '' and the
  // parent echoes '', which already equals what the box posts, so typing is never undone.
  // Compared as the box would show it, so a value with seconds or garbage settles after one pass.
  const parentValue = value === undefined ? undefined : compose(...split(value));
  if (parentValue !== undefined && parentValue !== posted && parentValue !== compose(day, time)) {
    setParts(split(value));
  }

  const latest = useRef({ day, posted, onChange });
  useInsertionEffect(() => {
    latest.current = { day, posted, onChange };
  });

  function update(nextDay: string, nextTime: string) {
    if (isResetting()) return;
    setParts([nextDay, nextTime]);
    // React Aria only reports a time once every segment is filled.
    if (nextTime !== time) markTimeIncomplete(false);
    const next = compose(nextDay, nextTime !== time ? nextTime : shownTime);
    if (next !== posted) onChange?.(next);
  }

  const watchTime = useCallback(
    (nowIncomplete: boolean, current: string) => {
      const was = timeIncompleteRef.current;
      if (nowIncomplete === was) return;
      markTimeIncomplete(nowIncomplete);
      const { day: currentDay, posted: wasPosted, onChange: report } = latest.current;
      // Retyping the time React Aria already holds completes the field without a change event.
      if (!nowIncomplete) setParts([currentDay, current]);
      const next = nowIncomplete ? '' : compose(currentDay, current);
      if (next !== wasPosted) report?.(next);
    },
    [markTimeIncomplete],
  );

  // A native datetime-local blocks a form while it is required and empty, or partly filled.
  const unfinished = (required === true && posted === '') || (day !== '') !== (shownTime !== '');

  const unfinishedMessage = useUnfinishedMessage(unfinished);
  const describedBy =
    [callerDescribedBy, unfinishedMessage.shown ? unfinishedMessage.id : undefined]
      .filter(Boolean)
      .join(' ') || undefined;

  const isInvalid =
    invalid === true || ariaInvalid === true || ariaInvalid === 'true' || unfinishedMessage.shown;

  return (
    <div ref={rootRef} className={[styles.root, className].filter(Boolean).join(' ')}>
      <div className={styles.row}>
        <DatePicker
          {...(id === undefined ? {} : { id })}
          className={styles.date ?? ''}
          value={day}
          onChange={(next) => update(next, time)}
          min={min?.slice(0, 10)}
          max={max?.slice(0, 10)}
          disabled={disabled}
          readOnly={readOnly}
          required={required}
          invalid={isInvalid}
          aria-labelledby={labelledBy}
          aria-describedby={describedBy}
          aria-label={ariaLabel}
          popoverContainer={popoverContainer}
          showBs={showBs}
        />
        <TimeField
          className={styles.time ?? ''}
          value={fedTime}
          onChange={(next) => update(day, next ? `${pad(next.hour)}:${pad(next.minute)}` : '')}
          granularity="minute"
          // The time is named by the field's own label plus "Time", and shares its hint and error.
          {...(labelledBy === undefined
            ? { 'aria-label': ariaLabel === undefined ? 'Time' : `${ariaLabel}, time` }
            : { 'aria-labelledby': `${labelledBy} ${timeId}` })}
          {...(describedBy === undefined ? {} : { 'aria-describedby': describedBy })}
          isDisabled={disabled === true}
          isReadOnly={readOnly === true}
          isRequired={required === true}
          isInvalid={isInvalid}
        >
          <Group className={pickerStyles.group ?? ''}>
            <DateInput className={pickerStyles.input ?? ''}>
              {(segment) => (
                <DateSegment segment={segment} className={pickerStyles.segment ?? ''} />
              )}
            </DateInput>
          </Group>
          <TimeCompletenessWatch onChange={watchTime} />
        </TimeField>
        <span id={timeId} hidden>
          Time
        </span>
      </div>
      {name ? (
        <input type="hidden" name={name} value={posted} disabled={disabled === true} />
      ) : null}
      {unfinished ? (
        <UnfinishedBlocker
          // A half-filled pair is held in a `noValidate` form; an empty required one is left to the form's own errors.
          hold={(day !== '') !== (shownTime !== '')}
          message="Enter the date and time"
          root={rootRef}
          disabled={disabled}
          messageId={unfinishedMessage.id}
          shown={unfinishedMessage.shown}
          onBlocked={unfinishedMessage.onBlocked}
        />
      ) : null}
    </div>
  );
}
