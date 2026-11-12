'use client';

import { useActionState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import styles from '../../kit.module.css';
import { submitMemoAction, type SubmitState } from '../actions';

/**
 * The Submit button. The page decides whether submitting is possible (`blocked`: a selected signer cannot
 * approve, so the API would refuse); this component also shows any refusal from the API in place.
 */
export function SubmitForm({ memoId, blocked }: { memoId: string; blocked: boolean }) {
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
        disabled={pending || blocked}
        aria-describedby={blocked ? 'submit-blocker' : undefined}
      >
        {pending ? 'Submitting' : 'Submit for approval'}
      </Button>
      {blocked ? (
        <p id="submit-blocker" className={styles.note}>
          Choose different people for the blocked step before submitting.
        </p>
      ) : null}
    </form>
  );
}
