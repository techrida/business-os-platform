'use client';

import { useActionState } from 'react';

import styles from '../../kit.module.css';
import { submitMemoAction, type SubmitState } from '../actions';

/**
 * The Submit button. The page decides whether submitting is possible (`blocker`); this component
 * only shows a refusal from the API in place, such as "an attachment is not clean yet".
 */
export function SubmitForm({ memoId, blocker }: { memoId: string; blocker: string | null }) {
  const [state, formAction, pending] = useActionState<SubmitState, FormData>(submitMemoAction, {});
  return (
    <form action={formAction}>
      <input type="hidden" name="memoId" value={memoId} />
      {state.error ? (
        <div
          className={`${styles.notice} ${styles.noticeBad}`}
          role="alert"
          style={{ marginBottom: '0.75rem' }}
        >
          <p>{state.error}</p>
        </div>
      ) : null}
      <button
        type="submit"
        className={styles.btn}
        disabled={pending || blocker !== null}
        aria-describedby={blocker !== null ? 'submit-blocker' : undefined}
      >
        {pending ? 'Submitting' : 'Submit for approval'}
      </button>
      {blocker !== null ? (
        <p id="submit-blocker" className={styles.hint} style={{ margin: '0.5rem 0 0' }}>
          {blocker}
        </p>
      ) : null}
    </form>
  );
}
