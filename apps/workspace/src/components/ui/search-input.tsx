import type { ComponentPropsWithRef } from 'react';

import { Icon } from './icon';
import styles from './search-input.module.css';

type SearchInputProps = Omit<ComponentPropsWithRef<'input'>, 'type'> & {
  wrapperClassName?: string;
};

/** A native search input. Supply an accessible name and let the caller own the search. */
export function SearchInput({ className, wrapperClassName, ...input }: SearchInputProps) {
  return (
    <span className={[styles.wrapper, wrapperClassName].filter(Boolean).join(' ')}>
      <Icon name="search" size={20} className={styles.icon} />
      <input
        {...input}
        type="search"
        className={[styles.input, className].filter(Boolean).join(' ')}
      />
    </span>
  );
}
