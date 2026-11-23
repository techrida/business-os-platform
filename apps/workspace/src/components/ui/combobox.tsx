'use client';

import {
  useEffect,
  useId,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
  type Ref,
} from 'react';
import { Popover } from 'react-aria-components';

import {
  ADD_OPTION_ID,
  addOptionFor,
  DEFAULT_GROUP_THRESHOLD,
  layoutOptions,
  moveActive,
  resultsAnnouncement,
  selectableIds,
  UNGROUPED_LABEL,
  type ComboboxOption,
} from './combobox-model';
import { Icon } from './icon';
import { dropdownPopoverProps, usePopoverContainer } from './popover-container';
import selectStyles from './select.module.css';
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
  /** The input's id, so a visible `<label for>` reaches it (clicking the label focuses the box). */
  id?: string;
  /** The input's form field name. Only a free-text field (`inputValue`) posts its text this way. */
  name?: string;
  /** Keep the options in the order given instead of sorting them by name. */
  keepOrder?: boolean;
  /**
   * Offers `Add "<typed text>"` as the last row when the text matches no option. Choosing it calls `onAdd` with the
   * trimmed text; the caller decides what adding means (here, a new lost reason saved with the form).
   */
  addOption?: {
    onAdd: (text: string) => void;
    label?: (text: string) => string;
    /** Offer the row even when an option has exactly the typed name (the typed name may still be a new record). */
    always?: boolean;
  };
  /**
   * Free-text mode (BOS-UI-002): the field owns its text instead of showing the chosen option's label. The text
   * stays in the box after the list closes or the add row is taken, typing reports through `onInputChange`, and
   * choosing an option reports through `onChange` (the caller then sets the text it wants, e.g. the option's name).
   * Enter with the list closed is left alone, so a free-text field still submits its form.
   */
  inputValue?: string;
  onInputChange?: (text: string) => void;
  /** The options already match the text (the caller searched for it): do not filter them again here. */
  serverFiltered?: boolean;
  /** `'add'` highlights the add row while typing, so Enter keeps the typed text; the default highlights the first match. */
  defaultActive?: 'first' | 'add';
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
  id,
  name,
  keepOrder = false,
  addOption,
  inputValue,
  onInputChange,
  serverFiltered = false,
  defaultActive = 'first',
  onBlurEmpty,
  inputRef,
  className,
}: ComboboxProps) {
  const freeText = inputValue !== undefined;
  const base = useId();
  const listId = `${base}-list`;
  const optionId = (id: string) => `${base}-o-${id}`;
  const rootRef = useRef<HTMLDivElement>(null);
  const internalInputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const container = usePopoverContainer();
  useImperativeHandle<HTMLInputElement | null, HTMLInputElement | null>(
    inputRef,
    () => internalInputRef.current,
    [],
  );
  const selected = options.find((o) => o.id === value);
  // `query` is null while the box simply shows the chosen label; a string while the user is searching.
  const [searching, setQuery] = useState<string | null>(null);
  const query = freeText ? inputValue : searching;
  const [activeId, setActiveId] = useState<string | null>(null);
  // What the options are filtered by here: nothing when the caller already searched for the text.
  const filterBy = (text: string) => (serverFiltered ? '' : text);

  // The "Add ..." row is appended to what is searched, so the keyboard and the screen reader treat it like any option.
  const withAdd = (list: readonly ComboboxOption[], text: string): readonly ComboboxOption[] => {
    const add =
      addOption === undefined
        ? null
        : addOptionFor(
            list,
            text,
            addOption.label ?? ((t) => `Add "${t}"`),
            addOption.always === true,
          );
    return add === null ? list : [...list, add];
  };
  const layout = useMemo(
    () =>
      layoutOptions(
        withAdd(options, query ?? ''),
        filterBy(query ?? ''),
        groupThreshold,
        ungroupedLabel,
        keepOrder,
      ),
    // withAdd closes over addOption only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [options, query, groupThreshold, ungroupedLabel, keepOrder, addOption, serverFiltered],
  );
  const ids = useMemo(() => selectableIds(layout.flat), [layout.flat]);
  // While text is typed, `defaultActive: 'add'` keeps the add row highlighted unless the arrows or the mouse moved off it.
  const addByDefault =
    defaultActive === 'add' && (query ?? '').trim() !== '' && ids.includes(ADD_OPTION_ID);
  const live = ids.includes(activeId ?? '') ? activeId : addByDefault ? ADD_OPTION_ID : null;

  // Keep the highlighted option in view as the arrows move.
  useEffect(() => {
    if (!open || live === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(live)}"]`)
      ?.scrollIntoView?.({ block: 'nearest' });
    // optionId is a pure function of base and the id.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live]);

  const close = () => {
    onOpenChange(false);
    setQuery(null);
    setActiveId(null);
  };
  const choose = (id: string) => {
    if (id === ADD_OPTION_ID) {
      const typed = (query ?? '').trim();
      close();
      if (typed !== '') addOption?.onAdd(typed);
      return;
    }
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
    onInputChange?.(text);
    // Typing is searching: the first match is highlighted so Enter takes it (or the add row, by `defaultActive`).
    const first =
      selectableIds(
        layoutOptions(
          withAdd(options, text),
          filterBy(text),
          groupThreshold,
          ungroupedLabel,
          keepOrder,
        ).flat,
      )[0] ?? null;
    setActiveId(text.trim() === '' || defaultActive === 'add' ? null : first);
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
      case 'Home':
      case 'End':
        if (open && query === null) {
          e.preventDefault();
          setActiveId(moveActive(ids, live, e.key));
        }
        break;
      case 'Enter':
        // Swallowed while the list is open (and always, outside free-text mode): Enter in a field must not submit
        // the form behind the list. A free-text field with its list closed submits as a plain input does.
        if (open || !freeText) e.preventDefault();
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

  const text = freeText ? inputValue : (query ?? selected?.label ?? '');
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
        if (
          e.currentTarget.contains(e.relatedTarget) ||
          popoverRef.current?.contains(e.relatedTarget)
        ) {
          return;
        }
        if (open || query !== null) close();
        if (value === '' && text === '') onBlurEmpty?.();
      }}
    >
      <input
        ref={internalInputRef}
        type="text"
        id={id}
        name={freeText ? name : undefined}
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
      <Popover
        ref={popoverRef}
        triggerRef={internalInputRef}
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        isNonModal
        className={`${selectStyles.popover ?? ''} ${styles.popover ?? ''}`}
        {...dropdownPopoverProps(container)}
      >
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
                className={[styles.option, o.id === live ? styles.active : undefined]
                  .filter(Boolean)
                  .join(' ')}
                onMouseMove={() => {
                  if (!o.disabled && o.id !== live) setActiveId(o.id);
                }}
                onClick={() => {
                  if (!o.disabled) choose(o.id);
                }}
              >
                <span className={styles.optionText}>
                  <span className={styles.name}>{o.label}</span>
                  {o.description ? <span className={styles.meta}>{o.description}</span> : null}
                  {o.disabled && o.disabledReason ? (
                    <span className={styles.meta}>{o.disabledReason}</span>
                  ) : null}
                </span>
                {o.id === value ? <Icon name="check" size={20} className={styles.check} /> : null}
              </div>
            ));
            return group.label === null || group.label === '' ? (
              <div key="flat" role="presentation" className={styles.groupItems}>
                {items}
              </div>
            ) : (
              <div
                key={group.key}
                role="group"
                aria-labelledby={`${base}-g-${group.key}`}
                className={styles.groupItems}
              >
                <div id={`${base}-g-${group.key}`} role="presentation" className={styles.group}>
                  {group.label}
                </div>
                {items}
              </div>
            );
          })}
        </div>
        {message ? <p className={styles.message}>{message}</p> : null}
      </Popover>
    </div>
  );
}
