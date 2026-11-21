'use client';

// Copy of the workspace DatePicker (apps/workspace/src/components/ui/date-picker.tsx), as the portal's number inputs are.

import { getLocalTimeZone, isToday, parseDate, type CalendarDate } from '@internationalized/date';
import { bsLongOfDay } from '@bos/locale';
import { useId, useState } from 'react';
import {
  Button,
  Calendar,
  CalendarCell,
  CalendarGrid,
  CalendarGridBody,
  CalendarGridHeader,
  CalendarHeaderCell,
  DateInput,
  DatePicker as AriaDatePicker,
  DateSegment,
  Dialog,
  Group,
  Heading,
  Popover,
} from 'react-aria-components';

import { dropdownPopoverProps, usePopoverContainer } from './popover-container';
import styles from './date-picker.module.css';

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

export interface DatePickerProps {
  /** Id of the field group. `Field` passes its control id here. */
  id?: string | undefined;
  /** Form field name. A hidden `<input type="date">` carries the ISO `YYYY-MM-DD` value. */
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
  ...aria
}: DatePickerProps) {
  const bsId = useId();
  const [typed, setTyped] = useState(defaultValue ?? '');
  const chosen = value !== undefined ? value : typed;
  const bs = showBs ? bsLongOfDay(chosen) : null;
  const describedBy =
    [aria['aria-describedby'], bs ? bsId : undefined].filter(Boolean).join(' ') || undefined;
  const contextContainer = usePopoverContainer();
  const container = popoverContainer ?? contextContainer;
  const isInvalid = invalid === true || ariaInvalid === true || ariaInvalid === 'true';
  const minValue = toCalendarDate(min);
  const maxValue = toCalendarDate(max);
  const optional = defined({
    id,
    name,
    isDisabled: disabled,
    isReadOnly: readOnly,
    isRequired: required,
    isInvalid: isInvalid || undefined,
    'aria-labelledby': aria['aria-labelledby'],
    'aria-describedby': describedBy,
    'aria-label': aria['aria-label'],
    ...(value !== undefined
      ? { value: toCalendarDate(value) }
      : { defaultValue: toCalendarDate(defaultValue) }),
  });

  return (
    <div className={[styles.root, className].filter(Boolean).join(' ')}>
      <AriaDatePicker
        {...optional}
        onChange={(next) => {
          const iso = next ? next.toString() : '';
          setTyped(iso);
          onChange?.(iso);
        }}
        minValue={minValue}
        maxValue={maxValue}
        className={styles.picker ?? ''}
      >
        <Group className={styles.group ?? ''}>
          <DateInput className={styles.input ?? ''}>
            {(segment) => <DateSegment segment={segment} className={styles.segment ?? ''} />}
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
      {bs ? (
        <span id={bsId} className={styles.bs}>
          {bs}
        </span>
      ) : null}
    </div>
  );
}
