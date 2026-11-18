'use client';

import {
  Button as Trigger,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
  type SelectProps,
} from 'react-aria-components';

import { Icon, type IconName } from './icon';
import styles from './dropdown-select.module.css';

type DropdownOption = { id: string; label: string; icon?: IconName };

type DropdownSelectProps = Omit<SelectProps<DropdownOption>, 'children' | 'className'> & {
  options: readonly DropdownOption[];
  /** Accepts the value Field hands to its control; mapped to React Aria's isInvalid. */
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
  /** For an enclosing modal, keep the list inside its focus and stacking boundary. */
  popoverContainer?: HTMLElement | undefined;
};

/** Select with icon-bearing options. A native Select is available from field.tsx. */
export function DropdownSelect({
  options,
  popoverContainer,
  'aria-invalid': ariaInvalid,
  isInvalid,
  ...props
}: DropdownSelectProps) {
  return (
    <AriaSelect
      {...props}
      isInvalid={isInvalid ?? (ariaInvalid === true || ariaInvalid === 'true')}
      className={styles.select ?? ''}
    >
      <Trigger className={styles.trigger ?? ''}>
        <SelectValue className={styles.value ?? ''} />
        <Icon name="chevron-down" size={20} />
      </Trigger>
      <Popover
        className={styles.popover ?? ''}
        offset={8}
        placement="bottom start"
        {...(popoverContainer
          ? {
              UNSTABLE_portalContainer: popoverContainer,
              boundaryElement: popoverContainer,
            }
          : {})}
      >
        <ListBox items={options} className={styles.list ?? ''}>
          {(option) => (
            <ListBoxItem id={option.id} textValue={option.label} className={styles.item ?? ''}>
              {({ isSelected }) => (
                <>
                  {option.icon && <Icon name={option.icon} size={20} />}
                  <span className={styles.label ?? ''}>{option.label}</span>
                  {isSelected && <Icon name="check-circle" size={20} />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
