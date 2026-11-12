'use client';

import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';

import {
  DEFAULT_GROUP_THRESHOLD,
  layoutOptions,
  moveActive,
  resultsAnnouncement,
  selectableIds,
  UNGROUPED_LABEL,
  type ComboboxOption,
} from './combobox-model';
import styles from './combobox.module.css';

/**
 * Lets several comboboxes share one rule: at most one list is open at a time. Give each combobox a key; opening one
 * closes whichever other was open, and a close from a stale owner is ignored.
 */
export function useExclusiveOpen(): {
  isOpen: (key: string) => boolean;
  setOpen: (key: string, open: boolean) => void;
} {
  const [openKey, setOpenKey] = useState<string | null>(null);
  return {
    isOpen: (key) => openKey === key,
    setOpen: (key, open) =>
      setOpenKey((current) => (open ? key : current === key ? null : current)),
  };
}

export interface ComboboxProps {
  /** The accessible name when no visible label points at the input through `labelledBy`. */
  label?: string;
  labelledBy?: string;
  /** Description ids (hints, errors) joined onto the input. */
  describedBy?: string | undefined;
  options: readonly ComboboxOption[];
  /** The chosen option's id, or '' for none. */
  value: string;
  onChange: (id: string) => void;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  /** More options than this and the list is grouped by each option's `group`. */
  groupThreshold?: number;
  ungroupedLabel?: string;
  /** Said when there is nothing to choose from at all. */
  emptyText?: string;
  /** Said when the search matches nothing. */
  noMatchText?: string;
  required?: boolean;
  invalid?: boolean;
  /** Called when the box loses focus with no value, e.g. to put a fixed choice back. */
  onBlurEmpty?: () => void;
  inputRef?: Ref<HTMLInputElement>;
  className?: string;
}

/**
 * An editable combobox (WAI-ARIA 1.2 "combobox with list autocomplete"): the box you click is the box you type
 * in, and the matching list opens right under it. Keyboard: ArrowDown opens and moves down, ArrowUp moves up,
 * Enter chooses the highlighted option (and never submits the form), Escape closes and puts the chosen name back,
 * Tab leaves. Clearing the text clears the choice. Focus stays in the input; the highlighted option is announced
 * through aria-activedescendant. A long list is grouped by each option's real group.
 */
export function Combobox({
  label,
  labelledBy,
  describedBy,
  options,
  value,
  onChange,
  open,
  onOpenChange,
  placeholder,
  groupThreshold = DEFAULT_GROUP_THRESHOLD,
  ungroupedLabel = UNGROUPED_LABEL,
  emptyText = 'Nothing to choose from.',
  noMatchText = 'No matches.',
  required,
  invalid,
  onBlurEmpty,
  inputRef,
  className,
}: ComboboxProps) {
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (id: string) => `${base}-o-${id}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const selected = options.find((o) => o.id === value);
  // `query` is null while the box simply shows the chosen label; a string while the user is searching.
  const [query, setQuery] = useState<string | null>(null);
  const [activeId, setActiveId] = useState<string | null>(null);

  const layout = useMemo(
    () => layoutOptions(options, query ?? '', groupThreshold, ungroupedLabel),
    [options, query, groupThreshold, ungroupedLabel],
  );
  const ids = useMemo(() => selectableIds(layout.flat), [layout.flat]);
  const live = ids.includes(activeId ?? '') ? activeId : null;

  // Keep the highlighted option in view as the arrows move.
  useEffect(() => {
    if (!open || live === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(live)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    // optionId is a pure function of base and the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live]);

  const close = () => {
    onOpenChange(false);
    setQuery(null);
    setActiveId(null);
  };
  const choose = (id: string) => {
    onChange(id);
    close();
  };
  const openList = (nextQuery: string | null, nextActive: string | null) => {
    setQuery(nextQuery);
    setActiveId(nextActive);
    onOpenChange(true);
  };

  function onInput(e: ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setQuery(text);
    // Typing is searching: the first match is highlighted so Enter takes it.
    const first =
      selectableIds(layoutOptions(options, text, groupThreshold, ungroupedLabel).flat)[0] ?? null;
    setActiveId(text.trim() === '' ? null : first);
    onOpenChange(true);
    // An emptied box means "nobody", not "keep the old name hidden behind a blank".
    if (text === '' && value !== '') onChange('');
  }

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case 'ArrowDown':
      case 'ArrowUp': {
        e.preventDefault();
        if (!open) {
          const start = selected && ids.includes(selected.id) ? selected.id : null;
          openList(
            null,
            e.key === 'ArrowDown'
              ? (start ?? ids[0] ?? null)
              : (start ?? ids[ids.length - 1] ?? null),
          );
        } else {
          setActiveId(moveActive(ids, live, e.key));
        }
        break;
      }
      case 'Enter':
        // Always swallowed: Enter in a field must not submit the memo form behind the list.
        e.preventDefault();
        if (open && live !== null) choose(live);
        break;
      case 'Escape':
        if (open) {
          // Close only the list, not whatever dialog or page handler sits above.
          e.preventDefault();
          e.stopPropagation();
          close();
        }
        break;
      case 'Tab':
        if (open) close();
        break;
      default:
    }
  }

  const text = query ?? selected?.label ?? '';
  const announcement = open
    ? resultsAnnouncement(layout.flat.length, options.length, {
        empty: emptyText,
        noMatch: noMatchText,
      })
    : '';
  const message =
    layout.flat.length === 0 ? (options.length === 0 ? emptyText : noMatchText) : null;

  return (
    <div
      ref={rootRef}
      className={[styles.root, className].filter(Boolean).join(' ')}
      onBlur={(e) => {
        if (e.currentTarget.contains(e.relatedTarget)) return;
        if (open || query !== null) close();
        if (value === '' && text === '') onBlurEmpty?.();
      }}
    >
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        className={styles.input}
        value={text}
        placeholder={placeholder}
        autoComplete="off"
        autoCapitalize="off"
        spellCheck={false}
        aria-autocomplete="list"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && live !== null ? optionId(live) : undefined}
        aria-label={labelledBy ? undefined : label}
        aria-labelledby={labelledBy}
        aria-describedby={describedBy}
        aria-required={required || undefined}
        aria-invalid={invalid || undefined}
        onChange={onInput}
        onKeyDown={onKeyDown}
        onFocus={(e) => e.currentTarget.select()}
        onClick={() => {
          if (!open) openList(null, selected && ids.includes(selected.id) ? selected.id : null);
        }}
      />
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {open ? (
        <div className={styles.popup}>
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label={label}
            aria-labelledby={labelledBy}
            className={styles.list}
            // Clicking an option must not blur the input, or the list would close before the click lands.
            onMouseDown={(e) => e.preventDefault()}
          >
            {layout.groups.map((group) => {
              const items = group.options.map((o) => (
                <div
                  key={o.id}
                  id={optionId(o.id)}
                  role="option"
                  aria-selected={o.id === value}
                  aria-disabled={o.disabled || undefined}
                  className={[
                    styles.option,
                    o.id === live ? styles.active : undefined,
                    o.disabled ? styles.disabled : undefined,
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  onMouseMove={() => {
                    if (!o.disabled && o.id !== live) setActiveId(o.id);
                  }}
                  onClick={() => {
                    if (!o.disabled) choose(o.id);
                  }}
                >
                  <span className={styles.name}>{o.label}</span>
                  {o.description ? <span className={styles.meta}>{o.description}</span> : null}
                  {o.disabled && o.disabledReason ? (
                    <span className={styles.meta}>{o.disabledReason}</span>
                  ) : null}
                  {o.id === value ? (
                    <span className={styles.check} aria-hidden="true">
                      ✓
                    </span>
                  ) : null}
                </div>
              ));
              return group.label === null ? (
                <div key="flat" role="presentation">
                  {items}
                </div>
              ) : (
                <div key={group.key} role="group" aria-labelledby={`${base}-g-${group.key}`}>
                  <div id={`${base}-g-${group.key}`} role="presentation" className={styles.group}>
                    {group.label}
                  </div>
                  {items}
                </div>
              );
            })}
          </div>
          {message ? <p className={styles.message}>{message}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
