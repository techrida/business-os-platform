'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

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
}: {
  action: (prev: MemoFormState, form: FormData) => Promise<MemoFormState>;
  initial: MemoValues;
  submitLabel: string;
  memoId?: string;
}) {
  const [state, formAction, pending] = useActionState<MemoFormState, FormData>(action, {
    values: initial,
    fieldErrors: {},
  });
  const [values, setValues] = useState<MemoValues>(initial);
  const id = useId();
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
    <form action={formAction} noValidate>
      {memoId ? <input type="hidden" name="memoId" value={memoId} /> : null}

      {state.error ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className={`${styles.notice} ${styles.noticeBad}`}
          style={{ marginBottom: '1rem' }}
        >
          <p>{state.error}</p>
        </div>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={`${id}-title`} className={styles.label}>
          Title
        </label>
        <input
          ref={titleRef}
          id={`${id}-title`}
          name="title"
          className={styles.input}
          value={values.title}
          onChange={set('title')}
          maxLength={200}
          required
          aria-invalid={err.title ? true : undefined}
          aria-describedby={err.title ? `${id}-title-err` : undefined}
        />
        {err.title ? (
          <span id={`${id}-title-err`} className={styles.fieldError}>
            {err.title}
          </span>
        ) : null}
      </div>

      <div className={styles.field}>
        <label htmlFor={`${id}-body`} className={styles.label}>
          Details
        </label>
        <textarea
          id={`${id}-body`}
          name="body"
          className={styles.input}
          rows={6}
          value={values.body}
          onChange={set('body')}
          maxLength={10000}
          aria-invalid={err.body ? true : undefined}
          aria-describedby={err.body ? `${id}-body-err` : undefined}
        />
        {err.body ? (
          <span id={`${id}-body-err`} className={styles.fieldError}>
            {err.body}
          </span>
        ) : null}
      </div>

      <div className={styles.row2}>
        <div className={styles.field}>
          <label htmlFor={`${id}-amount`} className={styles.label}>
            Amount
          </label>
          <input
            ref={amountRef}
            id={`${id}-amount`}
            name="amount"
            className={styles.input}
            inputMode="decimal"
            autoComplete="off"
            value={values.amount}
            onChange={set('amount')}
            required
            aria-invalid={err.amount ? true : undefined}
            aria-describedby={err.amount ? `${id}-amount-err` : `${id}-amount-hint`}
            style={{ fontVariantNumeric: 'tabular-nums' }}
          />
          <span id={`${id}-amount-hint`} className={styles.hint}>
            For example 1250.50. The NPR value is frozen when you save, using that day&apos;s rate.
          </span>
          {err.amount ? (
            <span id={`${id}-amount-err`} className={styles.fieldError}>
              {err.amount}
            </span>
          ) : null}
        </div>

        <div className={styles.field}>
          <label htmlFor={`${id}-currency`} className={styles.label}>
            Currency
          </label>
          <select
            id={`${id}-currency`}
            name="currency"
            className={styles.input}
            value={values.currency}
            onChange={set('currency')}
            aria-invalid={err.currency ? true : undefined}
            aria-describedby={err.currency ? `${id}-currency-err` : undefined}
          >
            {CURRENCY_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          {err.currency ? (
            <span id={`${id}-currency-err`} className={styles.fieldError}>
              {err.currency}
            </span>
          ) : null}
        </div>
      </div>

      <div className={styles.actions}>
        <button type="submit" className={styles.btn} disabled={pending}>
          {pending ? 'Saving' : submitLabel}
        </button>
      </div>
    </form>
  );
}
