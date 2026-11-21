'use client';

import { Time, parseTime } from '@internationalized/date';
import { DateInput, DateSegment, Group, TimeField } from 'react-aria-components';
import { useId, useRef, useState } from 'react';

import { DatePicker } from './date-picker';
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
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  'aria-label': ariaLabel,
  className,
  popoverContainer,
  showBs,
}: DateTimePickerProps) {
  const timeId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const [parts, setParts] = useState(() => split(value ?? defaultValue));
  // A form reset after a function action must not wipe a controlled value (see DatePicker).
  const isResetting = useFormReset(rootRef, () => setParts(split(defaultValue)));
  const [day, time] = parts;
  const posted = compose(day, time);

  // A controlled parent that holds another value wins. A partly filled box reports '' and the
  // parent echoes '', which already equals what the box composes, so typing is never undone.
  // Compared as the box would show it, so a value with seconds or garbage settles after one pass.
  if (value !== undefined && compose(...split(value)) !== posted) setParts(split(value));

  function update(nextDay: string, nextTime: string) {
    if (isResetting()) return;
    setParts([nextDay, nextTime]);
    const next = compose(nextDay, nextTime);
    if (next !== posted) onChange?.(next);
  }

  const isInvalid = invalid === true || ariaInvalid === true || ariaInvalid === 'true';

  return (
    <div ref={rootRef} className={[styles.row, className].filter(Boolean).join(' ')}>
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
        value={toTime(time)}
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
            {(segment) => <DateSegment segment={segment} className={pickerStyles.segment ?? ''} />}
          </DateInput>
        </Group>
      </TimeField>
      <span id={timeId} hidden>
        Time
      </span>
      {name ? (
        <input type="hidden" name={name} value={posted} disabled={disabled === true} />
      ) : null}
    </div>
  );
}
