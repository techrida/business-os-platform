'use client';

import { useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import {
  Button as Trigger,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
} from 'react-aria-components';

import { Icon } from './icon';
import { usePopoverContainer } from './popover-container';
import { useFormReset } from './use-form-reset';
import selectStyles from './select.module.css';
import styles from './multi-select.module.css';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export interface MultiSelectProps {
  /** Field name. Each selected value is submitted as its own repeated param, so a GET form works without JavaScript. */
  name: string;
  /** Accessible name of the control, for example "Status". */
  label: string;
  options: readonly MultiSelectOption[];
  /** Controlled selection. Pair with `onChange`. */
  value?: readonly string[] | undefined;
  /** Uncontrolled initial selection. */
  defaultValue?: readonly string[] | undefined;
  onChange?: ((values: string[]) => void) | undefined;
  /** Trigger text when nothing is selected, for example "All statuses". */
  allLabel?: string | undefined;
  /** Alias of `allLabel`. */
  placeholder?: string | undefined;
  /** Noun for the count once two or more are selected: "3 statuses". */
  pluralLabel?: string | undefined;
  className?: string | undefined;
}

/** Known values only, once each, in option order: stable URLs and no stale values submitted. */
function normalise(values: readonly string[], options: readonly MultiSelectOption[]): string[] {
  const wanted = new Set(values);
  return options.filter((o) => wanted.has(o.value)).map((o) => o.value);
}

const sameValues = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/**
 * A filter dropdown where several values can be on at once (Figma Dropdown 31:128 with the
 * Checkbox 26:1508 look). Trigger reads "All statuses", the one chosen label, or "3 statuses".
 * Built on React Aria's multiple Select: arrow keys, type-ahead, Space or Enter to toggle, Esc to
 * close, listbox ARIA with `aria-multiselectable`. The list stays open while toggling; the Clear
 * row empties the selection and closes it.
 *
 * Renders one hidden `<input name value>` per selected value (in the server HTML too), so a
 * surrounding `<form method="get">` submits `?status=a&status=b` with no JavaScript.
 */
export function MultiSelect({
  name,
  label,
  options,
  value,
  defaultValue,
  onChange,
  allLabel,
  placeholder,
  pluralLabel,
  className,
}: MultiSelectProps) {
  const controlled = value !== undefined;
  const initial = (defaults: readonly string[] | undefined) => normalise(defaults ?? [], options);
  const [inner, setInner] = useState(() => initial(defaultValue));
  // An uncontrolled control follows a changed `defaultValue`, as React does for native controls
  // (a filter whose URL changed under it). Compared by content: arrays get a new identity per render.
  const defaultKey = (defaultValue ?? []).join('\u0000');
  const [seenDefault, setSeenDefault] = useState(defaultKey);
  if (seenDefault !== defaultKey) {
    setSeenDefault(defaultKey);
    if (!controlled) setInner(initial(defaultValue));
  }
  const selected = controlled ? normalise(value, options) : inner;

  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const isResetting = useFormReset(root, () => {
    if (!controlled) setInner(initial(defaultValue));
  });
  const container = usePopoverContainer();

  const commit = (next: string[]) => {
    if (isResetting() || sameValues(next, selected)) return;
    // Commit before notifying, so a handler that submits the form reads the new value.
    flushSync(() => setInner(next));
    onChange?.(next);
  };

  const byValue = new Map(options.map((o) => [o.value, o.label]));
  const triggerText =
    selected.length === 0
      ? (allLabel ?? placeholder ?? 'All')
      : selected.length === 1
        ? (byValue.get(selected[0] ?? '') ?? '')
        : `${selected.length} ${pluralLabel ?? 'selected'}`;

  return (
    <AriaSelect
      ref={root}
      className={[selectStyles.select, className].filter(Boolean).join(' ')}
      selectionMode="multiple"
      value={selected}
      onChange={(keys) => commit(normalise(keys.map(String), options))}
      isOpen={open}
      onOpenChange={setOpen}
      aria-label={label}
    >
      {selected.map((v) => (
        <input key={v} type="hidden" name={name} value={v} />
      ))}
      <Trigger ref={triggerRef} className={selectStyles.trigger ?? ''}>
        {/* The text is ours: React Aria would join every selected label. */}
        <SelectValue className={selectStyles.value ?? ''}>{() => triggerText}</SelectValue>
        <Icon name="chevron-down" size={20} className={selectStyles.chevron} />
      </Trigger>
      <Popover
        className={selectStyles.popover ?? ''}
        offset={8}
        placement="bottom start"
        {...(container ? { UNSTABLE_portalContainer: container } : {})}
      >
        <ListBox
          aria-label={label}
          items={options.map((o) => ({ ...o, id: o.value }))}
          className={selectStyles.list ?? ''}
        >
          {(option) => (
            <ListBoxItem id={option.id} textValue={option.label} className={styles.item ?? ''}>
              {({ isSelected }) => (
                <>
                  {/* Decorative: aria-selected on the option carries the state. */}
                  <span className={styles.box} aria-hidden="true">
                    {isSelected ? <Icon name="check" size={14} /> : null}
                  </span>
                  <span className={selectStyles.label ?? ''}>{option.label}</span>
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
        <div className={styles.footer}>
          {/* A plain button: a list item here would be one more selectable key. */}
          <button
            type="button"
            className={styles.clear}
            disabled={selected.length === 0}
            onClick={() => {
              commit([]);
              // The Clear button leaves the page with the list; put focus back where the user started.
              triggerRef.current?.focus();
              setOpen(false);
            }}
          >
            Clear
          </button>
        </div>
      </Popover>
    </AriaSelect>
  );
}
