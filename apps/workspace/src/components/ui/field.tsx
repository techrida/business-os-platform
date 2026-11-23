import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import styles from './field.module.css';

/** What `Field` hands to its control so the label, hint and error are all wired up. */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  /** The label's id, for controls that are not a labelable element (the date picker). */
  'aria-labelledby': string;
}

/**
 * A labelled form field: label, optional hint, the control, optional error. The control is a
 * render function so it receives the ids it needs:
 *
 *   <Field label="Title" hint="Shown in the inbox" error={errors.title}>
 *     {(control) => <Input name="title" {...control} />}
 *   </Field>
 *
 * The label is a real `<label for>`, so the control's accessible name is exactly the label text.
 * The hint and error sit outside the label and are linked through `aria-describedby`. `error`
 * also sets `aria-invalid`. Works in Server and Client Components (no state).
 */
export function Field({
  label,
  optional,
  hint,
  error,
  children,
  className,
}: {
  label: ReactNode;
  /**
   * Marks a field that may be left empty with a muted "Optional" at the right end of the label row (UIP-FORM-008).
   * The label and the hint do not repeat it.
   */
  optional?: boolean;
  hint?: ReactNode;
  error?: ReactNode;
  children: (control: FieldControlProps) => ReactNode;
  className?: string;
}) {
  const base = useId();
  const labelId = `${base}-label`;
  const hintId = `${base}-hint`;
  const errorId = `${base}-error`;
  const describedBy =
    [hint ? hintId : undefined, error ? errorId : undefined].filter(Boolean).join(' ') || undefined;
  const cls = [styles.field, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className={styles.labelRow}>
        <label id={labelId} htmlFor={base} className={styles.label}>
          {label}
        </label>
        {optional ? <span className={styles.optional}>Optional</span> : null}
      </div>
      {children({
        id: base,
        'aria-describedby': describedBy,
        'aria-invalid': error ? true : undefined,
        'aria-labelledby': labelId,
      })}
      {hint ? (
        <span id={hintId} className={styles.hint}>
          {hint}
        </span>
      ) : null}
      {error ? (
        <span id={errorId} className={styles.error}>
          {error}
        </span>
      ) : null}
    </div>
  );
}

/** Text input (Figma Input 26:1449). Invalid state follows `aria-invalid`. */
export function Input({ className, ...rest }: ComponentPropsWithRef<'input'>) {
  return <input className={[styles.control, className].filter(Boolean).join(' ')} {...rest} />;
}

/** Multi-line input (Figma 26:1439). */
export function Textarea({ className, ...rest }: ComponentPropsWithRef<'textarea'>) {
  return (
    <textarea
      className={[styles.control, styles.textarea, className].filter(Boolean).join(' ')}
      {...rest}
    />
  );
}

/** The one dropdown. Lives in select.tsx; re-exported so forms import their controls from here. */
export { Select } from './select';
