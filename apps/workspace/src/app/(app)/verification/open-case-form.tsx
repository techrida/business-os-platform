'use client';

import { useActionState, useEffect, useRef } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { openCaseAction, type OpenCaseState } from './case-actions';
import styles from './verification.module.css';

/**
 * "Start verification" on the customer page. A Client Component only so a refusal shows next to
 * the button and keeps the Idempotency-Key honest after a timeout. On success the action sends the
 * person to the case, where the documents are attached.
 */
export function OpenCaseForm({
  partyId,
  idempotencyKey,
  label,
}: {
  partyId: string;
  /** A UUID the server generated for this render of the customer page. */
  idempotencyKey: string;
  label: string;
}) {
  const [state, formAction, pending] = useActionState<OpenCaseState, FormData>(openCaseAction, {
    key: idempotencyKey,
  });
  const summaryRef = useRef<HTMLDivElement>(null);

  // Move focus to what went wrong, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
  }, [state]);

  return (
    <form noValidate action={formAction} className={styles.openCase}>
      <input type="hidden" name="partyId" value={partyId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          actions={
            state.reload ? <a href={`/customers/${encodeURIComponent(partyId)}`}>Reload</a> : null
          }
        >
          {state.error}
        </Alert>
      ) : null}

      <div>
        <Button type="submit" disabled={pending}>
          {pending ? 'Starting' : label}
        </Button>
      </div>
      <p className="sr-only" role="status">
        {pending ? 'Starting the verification case' : ''}
      </p>
    </form>
  );
}
