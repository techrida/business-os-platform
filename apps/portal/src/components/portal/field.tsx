import { useId, type ComponentPropsWithRef, type ReactNode } from 'react';

import { FieldScope } from './field-scope';
import styles from './field.module.css';

/** What `Field` hands to its control so the label, hint and error are all wired up. */
export interface FieldControlProps {
  id: string;
  'aria-describedby': string | undefined;
  'aria-invalid': true | undefined;
  /** The label's id, for controls that are not a labelable element (the Select). */
  'aria-labelledby': string;
}

/**
 * Copied from apps/workspace/src/components/ui/field.tsx without Select (dedupe later).
 *
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
  // One reserved message line (UIP-FORM-010): an error replaces the hint, so it is that one element's id.
  const optionalId = `${base}-optional`;
  const describedBy = [optional ? optionalId : undefined, error ? errorId : hintId]
    .filter(Boolean)
    .join(' ');
  const cls = [styles.field, className].filter(Boolean).join(' ');
  return (
    <div className={cls}>
      <div className={styles.labelRow}>
        <label id={labelId} htmlFor={base} className={styles.label}>
          {label}
        </label>
        {optional ? (
          <span id={optionalId} className={styles.optional}>
            Optional
          </span>
        ) : null}
      </div>
      <FieldScope hint={hint} error={error} hintId={hintId} errorId={errorId} controlId={base}>
        {children({
          id: base,
          'aria-describedby': describedBy,
          'aria-invalid': error ? true : undefined,
          'aria-labelledby': labelId,
        })}
      </FieldScope>
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
