'use client';

import { useId, useRef, type KeyboardEvent } from 'react';

import styles from './activity-type-buttons.module.css';
import { ACTIVITY_KIND_LABELS } from './forms';

export type ActivityTypeKind = keyof typeof ACTIVITY_KIND_LABELS;

export interface ActivityTypeButtonsProps<K extends ActivityTypeKind> {
  /** The kinds offered, in order: `LOG_ACTIVITY_KINDS` or `SCHEDULE_ACTIVITY_KINDS`. */
  kinds: readonly K[];
  value: K;
  onChange: (kind: K) => void;
  /** Form field name; a hidden input posts the selected kind under it. */
  name: string;
  /** Visible group label, also the radio group's accessible name. */
  label: string;
  error?: string;
  disabled?: boolean;
}

const STEP: Partial<Record<string, 1 | -1>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Activity type picker (D40): one button per kind, behaving as a radio group. One tab stop (the
 * selected kind); arrow keys move and select, wrapping at the ends; Home and End jump. Unselected
 * kinds use the secondary button outline, the selected one fills with its kind's hue.
 */
export function ActivityTypeButtons<K extends ActivityTypeKind>({
  kinds,
  value,
  onChange,
  name,
  label,
  error,
  disabled = false,
}: ActivityTypeButtonsProps<K>) {
  const base = useId();
  const labelId = `${base}-label`;
  const errorId = `${base}-error`;
  const buttons = useRef<(HTMLButtonElement | null)[]>([]);
  const selected = kinds.indexOf(value);
  // With no valid selection the first kind takes the tab stop, as a native radio group does.
  const tabStop = selected === -1 ? 0 : selected;

  function select(index: number) {
    const kind = kinds[index];
    if (kind === undefined) return;
    buttons.current[index]?.focus();
    if (kind !== value) onChange(kind);
  }

  function onKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    const count = kinds.length;
    const step = STEP[event.key];
    let next: number | undefined;
    if (step !== undefined) next = (index + step + count) % count;
    else if (event.key === 'Home') next = 0;
    else if (event.key === 'End') next = count - 1;
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div className={styles.field}>
      <span id={labelId} className={styles.label}>
        {label}
      </span>
      <div
        role="radiogroup"
        aria-labelledby={labelId}
        aria-describedby={error ? errorId : undefined}
        aria-invalid={error ? true : undefined}
        aria-disabled={disabled || undefined}
        className={styles.group}
      >
        {kinds.map((kind, index) => {
          const checked = index === selected;
          return (
            <button
              key={kind}
              ref={(el) => {
                buttons.current[index] = el;
              }}
              type="button"
              role="radio"
              aria-checked={checked}
              tabIndex={index === tabStop ? 0 : -1}
              data-kind={kind}
              disabled={disabled}
              className={styles.option}
              onClick={() => select(index)}
              onKeyDown={(event) => onKeyDown(event, index)}
            >
              {ACTIVITY_KIND_LABELS[kind]}
            </button>
          );
        })}
      </div>
      <input type="hidden" name={name} value={selected === -1 ? '' : value} />
      {error ? (
        <span id={errorId} className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}
