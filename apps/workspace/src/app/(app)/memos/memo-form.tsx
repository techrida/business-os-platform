'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';

import styles from '../kit.module.css';
import type { MemoFormState, MemoValues } from './actions';

const CURRENCY_OPTIONS = [
  { value: 'NPR', label: 'NPR (Nepalese rupee)' },
  { value: 'INR', label: 'INR (Indian rupee)' },
  { value: 'USD', label: 'USD (US dollar)' },
];

/**
 * The memo create and edit form. One component for both, because they share fields and rules; the
 * server action passed in decides what happens on submit. Inputs are controlled so a refusal does
 * not wipe what was typed (React 19 resets uncontrolled fields after every action).
 */
export function MemoForm({
  action,
  initial,
  submitLabel,
  memoId,
  cancelHref,
}: {
  action: (prev: MemoFormState, form: FormData) => Promise<MemoFormState>;
  initial: MemoValues;
  submitLabel: string;
  memoId?: string;
  /** Adds a Cancel link beside the submit button (the create page; the edit card has none). */
  cancelHref?: string;
}) {
  const [state, formAction, pending] = useActionState<MemoFormState, FormData>(action, {
    values: initial,
    fieldErrors: {},
  });
  const [values, setValues] = useState<MemoValues>(initial);
  const summaryRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLInputElement>(null);
  const amountRef = useRef<HTMLInputElement>(null);

  const set = (key: keyof MemoValues) => (e: { target: { value: string } }) =>
    setValues((v) => ({ ...v, [key]: e.target.value }));

  // Send focus to the first thing that needs fixing.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
    else if (state.fieldErrors.title) titleRef.current?.focus();
    else if (state.fieldErrors.amount) amountRef.current?.focus();
  }, [state]);

  const err = state.fieldErrors;

  return (
    <form action={formAction} noValidate className={styles.form}>
      {memoId ? <input type="hidden" name="memoId" value={memoId} /> : null}

      {state.error ? (
        <Alert ref={summaryRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <Field label="Title" error={err.title}>
        {(control) => (
          <Input
            ref={titleRef}
            name="title"
            value={values.title}
            onChange={set('title')}
            maxLength={200}
            required
            {...control}
          />
        )}
      </Field>

      <Field label="Details" error={err.body}>
        {(control) => (
          <Textarea
            name="body"
            rows={6}
            value={values.body}
            onChange={set('body')}
            maxLength={10000}
            {...control}
          />
        )}
      </Field>

      <div className={styles.amountRow}>
        <Field
          label="Amount"
          hint="For example 1250.50. The NPR value is frozen when you save, using that day's rate."
          error={err.amount}
        >
          {(control) => (
            <Input
              ref={amountRef}
              name="amount"
              inputMode="decimal"
              autoComplete="off"
              value={values.amount}
              onChange={set('amount')}
              required
              className={styles.numeric}
              {...control}
            />
          )}
        </Field>

        <Field label="Currency" error={err.currency}>
          {(control) => (
            <Select name="currency" value={values.currency} onChange={set('currency')} {...control}>
              {CURRENCY_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </Select>
          )}
        </Field>
      </div>

      <div className={styles.formActions}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : submitLabel}
        </Button>
        {cancelHref ? (
          <LinkButton href={cancelHref} variant="secondary">
            Cancel
          </LinkButton>
        ) : null}
      </div>
    </form>
  );
}
