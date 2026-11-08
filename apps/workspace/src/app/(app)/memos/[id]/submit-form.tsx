'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import styles from '../../kit.module.css';
import { submitMemoAction, type SubmitState } from '../actions';

/**
 * The Submit button. The page decides whether submitting is possible (`blocker`); this component
 * only shows a refusal from the API in place, such as "an attachment is not clean yet".
 */
export function SubmitForm({ memoId, blocker }: { memoId: string; blocker: string | null }) {
  const [state, formAction, pending] = useActionState<SubmitState, FormData>(submitMemoAction, {});
  return (
    <form action={formAction} className={styles.submit}>
      <input type="hidden" name="memoId" value={memoId} />
      {state.error ? (
        <Alert tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}
      <Button
        type="submit"
        disabled={pending || blocker !== null}
        aria-describedby={blocker !== null ? 'submit-blocker' : undefined}
      >
        {pending ? 'Submitting' : 'Submit for approval'}
      </Button>
      {blocker !== null ? (
        <p id="submit-blocker" className={styles.note}>
          {blocker}
        </p>
      ) : null}
    </form>
  );
}
