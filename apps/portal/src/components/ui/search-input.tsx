'use client';

import { useRef, useState, type ChangeEvent, type ComponentPropsWithRef } from 'react';

import { Icon } from './icon';
import styles from './search-input.module.css';

type SearchInputProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & {
  wrapperClassName?: string | undefined;
};

function setRef(ref: SearchInputProps['ref'], node: HTMLInputElement | null) {
  if (typeof ref === 'function') ref(node);
  else if (ref) ref.current = node;
}

/**
 * A search input with the app's own clear button (the browser's "x" is hidden in globals.css). The
 * button shows only while there is text, is reachable by keyboard and returns focus to the input.
 * Clearing goes through a real `input` event, so controlled callers get their normal onChange and
 * uncontrolled forms keep working. Supply an accessible name and let the caller own the search.
 */
export function SearchInput({
  className,
  wrapperClassName,
  ref,
  onChange,
  ...input
}: SearchInputProps) {
  const inner = useRef<HTMLInputElement | null>(null);
  const [typed, setTyped] = useState(String(input.defaultValue ?? '').length > 0);
  const hasText = input.value !== undefined ? String(input.value).length > 0 : typed;
  const canClear = hasText && !input.disabled && !input.readOnly;

  function clear() {
    const el = inner.current;
    if (!el) return;
    // React tracks the value through the native setter, so set it there and fire a real event.
    const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
    descriptor?.set?.call(el, '');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.focus();
  }

  return (
    <span className={[styles.wrapper, wrapperClassName].filter(Boolean).join(' ')}>
      <Icon name="search" size={20} className={styles.icon} />
      <input
        {...input}
        ref={(node) => {
          inner.current = node;
          setRef(ref, node);
        }}
        type="search"
        className={[styles.input, className].filter(Boolean).join(' ')}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          setTyped(event.target.value.length > 0);
          onChange?.(event);
        }}
      />
      {canClear ? (
        <button type="button" className={styles.clear} aria-label="Clear search" onClick={clear}>
          <Icon name="x" size={16} />
        </button>
      ) : null}
    </span>
  );
}
