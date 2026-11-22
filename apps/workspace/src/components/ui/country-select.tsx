'use client';

import type { CountryCode } from '@bos/contracts';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type KeyboardEvent,
} from 'react';
import { Popover } from 'react-aria-components';

import { moveActive, resultsAnnouncement } from './combobox-model';
import {
  countryOption,
  countryOptions,
  dialLabel,
  phoneCountryOptions,
  searchCountries,
  type CountryOption,
} from './country-data';
import { Icon } from './icon';
import { dropdownPopoverProps, usePopoverContainer } from './popover-container';
import comboStyles from './combobox.module.css';
import selectStyles from './select.module.css';
import styles from './country-select.module.css';

export interface CountrySelectProps {
  /** The chosen country. A country is always chosen: clearing the text and leaving puts it back. */
  value: CountryCode;
  onChange: (code: CountryCode) => void;
  /** `Field` passes its control id here, so its `<label for>` names the box. */
  id?: string | undefined;
  /** Posts the ISO code through a hidden input. */
  name?: string | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /**
   * The phone-row form: the box shows the flag, the ISO code and the calling code (`+977`) instead of the name, and
   * only countries with phone numbers are listed.
   */
  compact?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A searchable country picker (WAI-ARIA 1.2 combobox with list autocomplete), built like `Combobox` and sharing its
 * look. Every ISO country, Nepal first, each with its flag, name, ISO code and calling code. The flag is never shown
 * alone: some systems draw an emoji flag as two letters, so the ISO code is always there as text. Search matches the
 * name, the ISO code (`us`) and the calling code (`977`, `+1`), best match first. Keyboard: ArrowDown opens and moves,
 * Enter chooses (and never submits the form), Escape closes and puts the chosen country back, Tab leaves. Works in a
 * Dialog: the list portals into the dialog's popover container.
 *
 *   <Field label="Country">{(control) => <CountrySelect {...control} value={c} onChange={setC} />}</Field>
 */
export function CountrySelect({
  value,
  onChange,
  id,
  name,
  'aria-label': ariaLabel,
  'aria-labelledby': labelledBy,
  'aria-describedby': describedBy,
  'aria-invalid': ariaInvalid,
  required,
  disabled,
  compact = false,
  className,
}: CountrySelectProps) {
  const base = useId();
  const listId = `${base}-list`;
  const nameId = `${base}-name`;
  const optionId = (code: string) => `${base}-o-${code}`;
  const boxRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const container = usePopoverContainer();

  const options = compact ? phoneCountryOptions() : countryOptions();
  const selected = countryOption(value);
  const [open, setOpen] = useState(false);
  // Null while the box shows the chosen country; a string while the user is searching.
  const [query, setQuery] = useState<string | null>(null);
  const [activeCode, setActiveCode] = useState<CountryCode | null>(null);

  const visible = useMemo(() => searchCountries(query ?? '', options), [options, query]);
  const ids = useMemo(() => visible.map((option) => option.code), [visible]);
  const live = activeCode !== null && ids.includes(activeCode) ? activeCode : null;

  useEffect(() => {
    if (!open || live === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(live)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    // optionId is a pure function of base and the code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live]);

  const close = () => {
    setOpen(false);
    setQuery(null);
    setActiveCode(null);
  };
  const choose = (code: CountryCode) => {
    if (code !== value) onChange(code);
    close();
  };
  const openList = (nextActive: CountryCode | null) => {
    setQuery(null);
    setActiveCode(nextActive);
    setOpen(true);
  };
  const selectedActive = ids.includes(value) ? value : null;

  function onInput(event: ChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    setQuery(text);
    // Typing is searching: the best match is highlighted so Enter takes it.
    setActiveCode(text.trim() === '' ? null : (searchCountries(text, options)[0]?.code ?? null));
    setOpen(true);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        if (!open) {
          openList(
            selectedActive ??
              (event.key === 'ArrowDown' ? (ids[0] ?? null) : (ids[ids.length - 1] ?? null)),
          );
        } else {
          setActiveCode(moveActive(ids, live, event.key) as CountryCode | null);
        }
        break;
      case 'Home':
      case 'End':
        if (open && query === null) {
          event.preventDefault();
          setActiveCode(moveActive(ids, live, event.key) as CountryCode | null);
        }
        break;
      case 'Enter':
        // Always swallowed: Enter in a field must not submit the form behind the list.
        event.preventDefault();
        if (open && live !== null) choose(live);
        break;
      case 'Escape':
        if (open || query !== null) {
          // Close only the list, not the dialog around it.
          event.preventDefault();
          event.stopPropagation();
          close();
        }
        break;
      case 'Tab':
        if (open) close();
        break;
      default:
    }
  }

  const shown = query ?? (compact ? dialLabel(selected) : selected.name);
  const invalid = ariaInvalid === true || ariaInvalid === 'true';
  const announcement = open
    ? resultsAnnouncement(visible.length, options.length, {
        empty: 'No countries.',
        noMatch: 'No country matches.',
      })
    : '';
  // The compact box shows only the calling code, so the country's name is read out as its description.
  const described =
    [compact ? nameId : undefined, describedBy].filter(Boolean).join(' ') || undefined;

  return (
    <div
      className={[styles.root, compact ? styles.compact : undefined, className]
        .filter(Boolean)
        .join(' ')}
      onBlur={(event) => {
        if (
          event.currentTarget.contains(event.relatedTarget) ||
          popoverRef.current?.contains(event.relatedTarget)
        ) {
          return;
        }
        if (open || query !== null) close();
      }}
    >
      <div
        ref={boxRef}
        className={styles.box}
        data-invalid={invalid || undefined}
        data-disabled={disabled || undefined}
        onMouseDown={(event) => {
          const input = inputRef.current;
          if (!input || disabled || event.target === input) return;
          event.preventDefault();
          input.focus();
          if (!open) openList(selectedActive);
        }}
      >
        <span className={styles.chip} aria-hidden="true">
          <span className={styles.flag}>{selected.flag}</span>
          <span className={styles.code}>{selected.code}</span>
        </span>
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          className={styles.input}
          value={shown}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={open}
          aria-controls={listId}
          aria-activedescendant={open && live !== null ? optionId(live) : undefined}
          {...(id === undefined ? {} : { id })}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          {...(labelledBy === undefined && ariaLabel !== undefined
            ? { 'aria-label': ariaLabel }
            : {})}
          {...(described === undefined ? {} : { 'aria-describedby': described })}
          {...(required ? { 'aria-required': true } : {})}
          {...(invalid ? { 'aria-invalid': true } : {})}
          disabled={disabled === true}
          onChange={onInput}
          onKeyDown={onKeyDown}
          onFocus={(event) => event.currentTarget.select()}
          onClick={() => {
            if (!open) openList(selectedActive);
          }}
        />
        <Icon name="chevron-down" size={16} className={styles.chevron} />
      </div>
      {compact ? (
        <span id={nameId} className="sr-only">
          {selected.name}
        </span>
      ) : null}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      {name ? <input type="hidden" name={name} value={value} disabled={disabled === true} /> : null}
      <Popover
        ref={popoverRef}
        triggerRef={boxRef}
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) close();
        }}
        isNonModal
        className={[selectStyles.popover, comboStyles.popover, styles.popover]
          .filter(Boolean)
          .join(' ')}
        {...dropdownPopoverProps(container)}
      >
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          {...(labelledBy === undefined ? { 'aria-label': ariaLabel ?? 'Country' } : {})}
          {...(labelledBy === undefined ? {} : { 'aria-labelledby': labelledBy })}
          className={comboStyles.list}
          // Clicking an option must not blur the input, or the list would close before the click lands.
          onMouseDown={(event) => event.preventDefault()}
        >
          {visible.map((option) => (
            <CountryRow
              key={option.code}
              id={optionId(option.code)}
              option={option}
              selected={option.code === value}
              active={option.code === live}
              onHover={() => {
                if (option.code !== live) setActiveCode(option.code);
              }}
              onChoose={() => choose(option.code)}
            />
          ))}
        </div>
        {visible.length === 0 ? <p className={comboStyles.message}>No country matches.</p> : null}
      </Popover>
    </div>
  );
}

function CountryRow({
  id,
  option,
  selected,
  active,
  onHover,
  onChoose,
}: {
  id: string;
  option: CountryOption;
  selected: boolean;
  active: boolean;
  onHover: () => void;
  onChoose: () => void;
}) {
  return (
    <div
      id={id}
      role="option"
      aria-selected={selected}
      className={[comboStyles.option, active ? comboStyles.active : undefined]
        .filter(Boolean)
        .join(' ')}
      onMouseMove={onHover}
      onClick={onChoose}
    >
      <span className={styles.flag} aria-hidden="true">
        {option.flag}
      </span>
      <span className={comboStyles.optionText}>
        <span className={comboStyles.name}>{option.name}</span>
        <span className={[comboStyles.meta, styles.optionMeta].join(' ')}>
          {option.code}
          {option.dial === null ? '' : ` ${dialLabel(option)}`}
        </span>
      </span>
      {selected ? <Icon name="check" size={20} className={comboStyles.check} /> : null}
    </div>
  );
}
