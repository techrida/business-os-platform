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
  dialLabel,
  phoneCountryOptions,
  searchCountries,
  type CountryOption,
} from './country-data';
import { Icon } from './icon';
import { dropdownPopoverProps, usePopoverContainer } from './popover-container';
import comboStyles from './combobox.module.css';
import selectStyles from './select.module.css';
import styles from './phone-country-menu.module.css';

export interface PhoneCountryMenuProps {
  value: CountryCode;
  /** A different country was picked in the menu. */
  onChange: (code: CountryCode) => void;
  /** The chosen country was picked again (a deliberate pick of the country already shown). */
  onReselect?: ((code: CountryCode) => void) | undefined;
  /** Posts the ISO code through a hidden input. */
  name?: string | undefined;
  'aria-label': string;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  /** The element the popover anchors to (the whole field), so the list is as wide as the box. */
  anchorRef: React.RefObject<HTMLElement | null>;
}

/**
 * The flag half of the one-box phone field: a button with the flag and a chevron, no dial-code text (the code is in the
 * number). It opens a searchable list of the countries that have phone numbers, Nepal first, each with its flag, name
 * and calling code. Built like `CountrySelect` (WAI-ARIA 1.2 combobox: the button is the select-only combobox, the
 * list's search box holds the typing). Keyboard: Enter, Space or ArrowDown on the button opens; in the search box
 * ArrowUp/ArrowDown move, Enter chooses (and never submits the form), Escape closes and returns to the button.
 */
export function PhoneCountryMenu({
  value,
  onChange,
  onReselect,
  name,
  'aria-label': ariaLabel,
  disabled,
  invalid,
  anchorRef,
}: PhoneCountryMenuProps) {
  const base = useId();
  const listId = `${base}-list`;
  const nameId = `${base}-name`;
  const optionId = (code: string) => `${base}-o-${code}`;
  const buttonRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const popoverRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const container = usePopoverContainer();

  const options = phoneCountryOptions();
  const selected = countryOption(value);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [activeCode, setActiveCode] = useState<CountryCode | null>(null);

  const visible = useMemo(() => searchCountries(query, options), [options, query]);
  const ids = useMemo(() => visible.map((option) => option.code), [visible]);
  const live = activeCode !== null && ids.includes(activeCode) ? activeCode : null;

  useEffect(() => {
    if (!open) return;
    searchRef.current?.focus();
  }, [open]);
  useEffect(() => {
    if (!open || live === null) return;
    listRef.current
      ?.querySelector<HTMLElement>(`[id="${optionId(live)}"]`)
      ?.scrollIntoView({ block: 'nearest' });
    // optionId is a pure function of base and the code.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, live]);

  const close = (refocus: boolean) => {
    setOpen(false);
    setQuery('');
    setActiveCode(null);
    if (refocus) buttonRef.current?.focus();
  };
  const choose = (code: CountryCode) => {
    if (code !== value) onChange(code);
    else onReselect?.(code);
    close(true);
  };
  const openList = () => {
    setQuery('');
    setActiveCode(ids.includes(value) ? value : (ids[0] ?? null));
    setOpen(true);
  };

  function onButtonKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (!open) openList();
    }
  }

  function onSearch(event: ChangeEvent<HTMLInputElement>) {
    const text = event.target.value;
    setQuery(text);
    setActiveCode(text.trim() === '' ? null : (searchCountries(text, options)[0]?.code ?? null));
  }

  function onSearchKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.nativeEvent.isComposing) return;
    switch (event.key) {
      case 'ArrowDown':
      case 'ArrowUp':
        event.preventDefault();
        setActiveCode(moveActive(ids, live, event.key) as CountryCode | null);
        break;
      case 'Enter':
        // Always swallowed: Enter in the search must not submit the form behind the list.
        event.preventDefault();
        if (live !== null) choose(live);
        break;
      case 'Escape':
        event.preventDefault();
        event.stopPropagation();
        close(true);
        break;
      case 'Tab':
        close(false);
        break;
      default:
    }
  }

  const announcement = open
    ? resultsAnnouncement(visible.length, options.length, {
        empty: 'No countries.',
        noMatch: 'No country matches.',
      })
    : '';

  return (
    <div
      className={styles.root}
      onBlur={(event) => {
        if (
          event.currentTarget.contains(event.relatedTarget) ||
          popoverRef.current?.contains(event.relatedTarget)
        ) {
          return;
        }
        if (open) close(false);
      }}
    >
      <button
        ref={buttonRef}
        type="button"
        role="combobox"
        className={styles.trigger}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={open ? listId : undefined}
        aria-describedby={nameId}
        {...(invalid ? { 'aria-invalid': true } : {})}
        disabled={disabled === true}
        onClick={() => (open ? close(false) : openList())}
        onKeyDown={onButtonKeyDown}
      >
        <span className={styles.flag} aria-hidden="true">
          {selected.flag}
        </span>
        <Icon name="chevron-down" size={16} className={styles.chevron} />
      </button>
      <span id={nameId} className="sr-only">
        {selected.name} {dialLabel(selected)}
      </span>
      {name ? <input type="hidden" name={name} value={value} disabled={disabled === true} /> : null}
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
      <Popover
        ref={popoverRef}
        triggerRef={anchorRef}
        isOpen={open}
        onOpenChange={(next) => {
          if (!next) close(false);
        }}
        isNonModal
        className={[selectStyles.popover, comboStyles.popover, styles.popover]
          .filter(Boolean)
          .join(' ')}
        {...dropdownPopoverProps(container)}
      >
        <input
          ref={searchRef}
          type="text"
          className={styles.search}
          placeholder="Search countries"
          aria-label={`${ariaLabel} search`}
          autoComplete="off"
          autoCapitalize="off"
          spellCheck={false}
          value={query}
          onChange={onSearch}
          onKeyDown={onSearchKeyDown}
          aria-controls={listId}
          aria-activedescendant={live !== null ? optionId(live) : undefined}
        />
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label={ariaLabel}
          className={comboStyles.list}
          // Clicking an option must not blur the search, or the list would close before the click lands.
          onMouseDown={(event) => event.preventDefault()}
        >
          {visible.map((option) => (
            <PhoneCountryRow
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

function PhoneCountryRow({
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
