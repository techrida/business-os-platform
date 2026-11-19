'use client';

import { useMemo, useRef, useState } from 'react';
import {
  ComboBox,
  Input as AriaInput,
  ListBox,
  ListBoxItem,
  Popover,
  useFilter,
} from 'react-aria-components';

import { Icon } from './icon';
import fieldStyles from './field.module.css';
import { usePopoverContainer } from './popover-container';
import styles from './select.module.css';
import { useFormReset } from './use-form-reset';

export interface SuggestInputProps {
  /** Submitted through the real text input, so it is the typed text, not a chosen key. */
  name?: string | undefined;
  /** Controlled text. Pair with `onChange`. */
  value?: string | undefined;
  /** Uncontrolled initial text. */
  defaultValue?: string | undefined;
  /** Receives the new text on every keystroke and when a suggestion is picked. */
  onChange?: ((value: string) => void) | undefined;
  /** Offered in the list, filtered by what was typed. Any other text is accepted too. */
  suggestions: readonly string[];
  placeholder?: string | undefined;
  autoComplete?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
  form?: string | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  autoFocus?: boolean | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
}

/**
 * A free-text field with a list of suggestions, in place of an input with a native `<datalist>`
 * (whose popup is drawn by the operating system, not by our design). Built on React Aria's
 * ComboBox: the list opens on focus, narrows to suggestions that contain the typed text, and is
 * styled and placed like the Select's list (it flips above the field near the viewport bottom,
 * and portals into a dialog on its own).
 *
 * Unlike Select it accepts any text. The typed text is what the form submits, through a normal
 * `name` on the real input; picking a suggestion just types it for the user.
 */
export function SuggestInput({
  name,
  value,
  defaultValue,
  onChange,
  suggestions,
  placeholder,
  autoComplete,
  id,
  className,
  form,
  required,
  disabled,
  autoFocus,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: SuggestInputProps) {
  const { contains } = useFilter({ sensitivity: 'base' });
  const container = usePopoverContainer();
  // Empty strings cannot be keys, and a repeated suggestion would repeat its key.
  const items = useMemo(
    () =>
      Array.from(new Set(suggestions))
        .filter((s) => s !== '')
        .map((s) => ({ id: s })),
    [suggestions],
  );
  const controlled = value !== undefined;
  const root = useRef<HTMLDivElement>(null);
  // Own the text so a changed `defaultValue` (values echoed back after a failed submit) and a
  // form reset put the right text back; React Aria alone would restore its first render's.
  const [text, setText] = useState(defaultValue ?? '');
  const [seenDefault, setSeenDefault] = useState(defaultValue);
  if (seenDefault !== defaultValue) {
    setSeenDefault(defaultValue);
    if (!controlled) setText(defaultValue ?? '');
  }
  const isResetting = useFormReset(root, () => {
    if (!controlled) setText(defaultValue ?? '');
  });

  return (
    <ComboBox
      ref={root}
      allowsCustomValue
      menuTrigger="focus"
      defaultFilter={contains}
      defaultItems={items}
      className={[styles.select, className].filter(Boolean).join(' ')}
      isRequired={Boolean(required)}
      isDisabled={Boolean(disabled)}
      validationBehavior="native"
      autoFocus={Boolean(autoFocus)}
      inputValue={controlled ? value : text}
      onInputChange={(next) => {
        if (isResetting()) return;
        if (!controlled) setText(next);
        onChange?.(next);
      }}
      {...(name ? { name } : {})}
      {...(form ? { form } : {})}
      {...(id ? { id } : {})}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(ariaLabelledBy ? { 'aria-labelledby': ariaLabelledBy } : {})}
      {...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {})}
    >
      <AriaInput
        className={fieldStyles.control ?? ''}
        placeholder={placeholder ?? ''}
        // Not React Aria's `isInvalid`: with native validation it sets a custom validity that
        // keeps the form blocked after a server error is shown, until the browser is reloaded.
        {...(ariaInvalid === true || ariaInvalid === 'true' ? { 'aria-invalid': true } : {})}
        {...(autoComplete ? { autoComplete } : {})}
      />
      <Popover
        className={styles.popover ?? ''}
        offset={8}
        placement="bottom start"
        {...(container ? { UNSTABLE_portalContainer: container, boundaryElement: container } : {})}
      >
        <ListBox className={styles.list ?? ''}>
          {(item: { id: string }) => (
            <ListBoxItem id={item.id} textValue={item.id} className={styles.item ?? ''}>
              {({ isSelected }) => (
                <>
                  <span className={styles.label ?? ''}>{item.id}</span>
                  {isSelected ? <Icon name="check" size={20} className={styles.tick} /> : null}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </ComboBox>
  );
}
