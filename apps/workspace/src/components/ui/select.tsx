'use client';

import {
  Children,
  Fragment,
  isValidElement,
  useCallback,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  type ReactElement,
  type ReactNode,
  type Ref,
} from 'react';
import { flushSync } from 'react-dom';
import {
  Button as Trigger,
  ListBox,
  ListBoxItem,
  Popover,
  Select as AriaSelect,
  SelectValue,
} from 'react-aria-components';

import { Icon, type IconName } from './icon';
import { usePopoverContainer } from './popover-container';
import { useFormReset } from './use-form-reset';
import styles from './select.module.css';

/** What `onChange` receives: the parts of a native change event that callers read. */
export interface SelectChangeEvent {
  target: { name: string; value: string };
  currentTarget: { name: string; value: string; form: HTMLFormElement | null };
}

/** Handed out through `ref`, for focusing the control after a validation error. */
export interface SelectHandle {
  focus: () => void;
}

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  icon?: IconName | undefined;
}

export interface SelectProps {
  /** `<option>` elements, as for a native select. A `value=""` option is the placeholder when `required`. */
  children?: ReactNode;
  /** Same as `children`, for lists built in code. */
  options?: readonly SelectOption[];
  name?: string | undefined;
  /** Controlled value. Pair with `onChange`. */
  value?: string | number | undefined;
  /** Uncontrolled initial value. */
  defaultValue?: string | number | undefined;
  onChange?: ((event: SelectChangeEvent) => void) | undefined;
  required?: boolean | undefined;
  disabled?: boolean | undefined;
  /** Shown when nothing is selected. Defaults to the label of the empty option. */
  placeholder?: string | undefined;
  id?: string | undefined;
  className?: string | undefined;
  form?: string | undefined;
  autoFocus?: boolean | undefined;
  ref?: Ref<SelectHandle> | undefined;
  'aria-label'?: string | undefined;
  'aria-labelledby'?: string | undefined;
  'aria-describedby'?: string | undefined;
  'aria-invalid'?: boolean | 'true' | 'false' | undefined;
}

/** Key for the empty-string option: React Aria keys must not be empty. */
const EMPTY = '__empty__';
const toKey = (value: string) => (value === '' ? EMPTY : value);
const fromKey = (key: string) => (key === EMPTY ? '' : key);

function textOf(node: ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return '';
}

/** Reads `<option>` children (also inside fragments and arrays) into a flat list. */
function readOptions(children: ReactNode): SelectOption[] {
  const found: SelectOption[] = [];
  const visit = (nodes: ReactNode) => {
    Children.forEach(nodes, (child) => {
      if (!isValidElement(child)) return;
      const element = child as ReactElement<{
        value?: string | number;
        disabled?: boolean;
        children?: ReactNode;
      }>;
      if (element.type === Fragment) return visit(element.props.children);
      if (element.type === 'optgroup') return visit(element.props.children);
      if (element.type !== 'option') return;
      const label = textOf(element.props.children);
      const value = element.props.value === undefined ? label : String(element.props.value);
      found.push({ value, label, ...(element.props.disabled ? { disabled: true } : {}) });
    });
  };
  visit(children);
  return found;
}

/**
 * The one dropdown (Figma Dropdown 430:8428, item states 31:112), built on React Aria's Select:
 * arrow keys, type-ahead, Home/End, Enter/Space to pick, Esc to close, listbox ARIA, a floating
 * panel that flips above the trigger near the viewport bottom, and a hidden native field that
 * keeps form submission and `required` validation working.
 *
 * The API follows the native select it replaces: `<option>` children, `name`, `value` /
 * `defaultValue`, `required`, `disabled`, and an `onChange` whose event has `target.value` and
 * `currentTarget.form`. When `required`, an `<option value="">` becomes the placeholder instead
 * of a choice; otherwise it is a normal choice ("All", "None").
 *
 * Inside a `Dialog` the list portals into the dialog on its own.
 */
export function Select({
  children,
  options: optionProp,
  name,
  value,
  defaultValue,
  onChange,
  required,
  disabled,
  placeholder,
  id,
  className,
  form,
  autoFocus,
  ref,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledBy,
  'aria-describedby': ariaDescribedBy,
  'aria-invalid': ariaInvalid,
}: SelectProps) {
  const all = optionProp ?? readOptions(children);
  const emptyOption = all.find((o) => o.value === '');
  const placeholderOnly = Boolean(required && emptyOption);
  const items = placeholderOnly ? all.filter((o) => o.value !== '') : all;
  const placeholderText = placeholder ?? (placeholderOnly ? emptyOption?.label : undefined);

  const controlled = value !== undefined;
  // Like a native select, start on the first choice when nothing is chosen and there is no empty option.
  const initialFor = (defaults: string | number | undefined) =>
    defaults !== undefined
      ? String(defaults)
      : emptyOption
        ? ''
        : (all.find((o) => !o.disabled)?.value ?? '');
  const [inner, setInner] = useState(() => initialFor(defaultValue));
  // An uncontrolled select follows a changed `defaultValue`, as React does for native controls
  // (a filter whose URL changed under it).
  const [seenDefault, setSeenDefault] = useState(defaultValue);
  if (seenDefault !== defaultValue) {
    setSeenDefault(defaultValue);
    if (value === undefined) setInner(initialFor(defaultValue));
  }
  const current = controlled ? String(value) : inner;
  const selected = current === '' && placeholderOnly ? null : toKey(current);
  // A value that matches no option (stale data) must not silently read as the first one.
  const known = selected === null || items.some((o) => toKey(o.value) === selected);

  // Styled from the caller's error, not React Aria's isInvalid, which would keep the form invalid.
  const invalid = ariaInvalid === true || ariaInvalid === 'true';
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const isResetting = useFormReset(root, () => {
    if (value === undefined) setInner(initialFor(defaultValue));
  });
  useImperativeHandle(ref, () => ({ focus: () => trigger.current?.focus() }), []);
  // React Aria's Button drops `aria-invalid`, so set it on the element itself.
  useEffect(() => {
    if (invalid) trigger.current?.setAttribute('aria-invalid', 'true');
    else trigger.current?.removeAttribute('aria-invalid');
  }, [invalid]);
  const container = usePopoverContainer();

  // A `<label htmlFor={id}>` outside the component names the trigger: React Aria labels it with
  // aria-labelledby, which would otherwise hide that label. The label gets a stable id on mount.
  const forLabelId = !ariaLabel && !ariaLabelledBy && id ? `${id}__label` : undefined;
  const [adoptedLabel, setAdoptedLabel] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!forLabelId || !id) return;
    const label = document.querySelector<HTMLLabelElement>(`label[for="${CSS.escape(id)}"]`);
    if (!label) return;
    if (!label.id) label.id = forLabelId;
    setAdoptedLabel(label.id);
  }, [forLabelId, id]);
  const labelledBy = ariaLabelledBy ?? adoptedLabel ?? forLabelId;

  const pick = useCallback(
    (key: string | number | null) => {
      if (key === null || isResetting()) return;
      const next = fromKey(String(key));
      // Commit before notifying, so a handler that submits the form reads the new value.
      flushSync(() => setInner(next));
      const form = root.current?.closest('form') ?? null;
      onChange?.({
        target: { name: name ?? '', value: next },
        currentTarget: { name: name ?? '', value: next, form },
      });
    },
    [name, onChange, isResetting],
  );

  return (
    <AriaSelect
      ref={root}
      className={[styles.select, invalid ? styles.invalid : '', className]
        .filter(Boolean)
        .join(' ')}
      selectedKey={known ? selected : null}
      onSelectionChange={pick}
      isRequired={Boolean(required)}
      isDisabled={Boolean(disabled)}
      validationBehavior="native"
      autoFocus={Boolean(autoFocus)}
      placeholder={placeholderText ?? ''}
      {...(ariaLabel ? { 'aria-label': ariaLabel } : {})}
      {...(labelledBy ? { 'aria-labelledby': labelledBy } : {})}
      {...(ariaDescribedBy ? { 'aria-describedby': ariaDescribedBy } : {})}
    >
      {/* Submits the real value; the hidden select React Aria renders is unnamed and keys the empty option. */}
      {name ? (
        <input
          type="hidden"
          name={name}
          value={current}
          disabled={disabled}
          {...(form ? { form } : {})}
        />
      ) : null}
      <Trigger ref={trigger} className={styles.trigger ?? ''} {...(id ? { id } : {})}>
        <SelectValue className={styles.value ?? ''} />
        <Icon name="chevron-down" size={20} className={styles.chevron} />
      </Trigger>
      <Popover
        className={styles.popover ?? ''}
        offset={8}
        placement="bottom start"
        {...(container ? { UNSTABLE_portalContainer: container } : {})}
      >
        <ListBox
          items={items.map((o) => ({ ...o, id: toKey(o.value) }))}
          className={styles.list ?? ''}
        >
          {(option) => (
            <ListBoxItem
              id={option.id}
              textValue={option.label}
              isDisabled={Boolean(option.disabled)}
              className={styles.item ?? ''}
            >
              {({ isSelected }) => (
                <>
                  {option.icon ? <Icon name={option.icon} size={20} /> : null}
                  <span className={styles.label ?? ''}>{option.label}</span>
                  {isSelected ? <Icon name="check" size={20} className={styles.tick} /> : null}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </AriaSelect>
  );
}
