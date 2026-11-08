'use client';

import { useActionState, useId } from 'react';

import styles from '../kit.module.css';
import { openMemoAction, type OpenState } from './actions';

/** Opens a memo by id. A stopgap until the API has a list route; see the memos page. */
export function OpenMemoForm() {
  const [state, formAction, pending] = useActionState<OpenState, FormData>(openMemoAction, {});
  const id = useId();
  return (
    <form action={formAction} noValidate>
      <div className={styles.field} style={{ marginBottom: '0.75rem' }}>
        <label htmlFor={`${id}-id`} className={styles.label}>
          Memo id
        </label>
        <input
          id={`${id}-id`}
          name="memoId"
          className={`${styles.input} ${styles.mono}`}
          autoComplete="off"
          spellCheck={false}
          aria-invalid={state.error ? true : undefined}
          aria-describedby={state.error ? `${id}-err` : undefined}
        />
        {state.error ? (
          <span id={`${id}-err`} className={styles.fieldError} role="alert">
            {state.error}
          </span>
        ) : null}
      </div>
      <button type="submit" className={`${styles.btn} ${styles.btnSecondary}`} disabled={pending}>
        Open memo
      </button>
    </form>
  );
}
