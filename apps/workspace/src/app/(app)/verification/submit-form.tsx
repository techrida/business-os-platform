'use client';

import { useActionState, useEffect, useRef } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';

import { submitCaseAction, type SubmitCaseState } from './case-actions';
import styles from './verification.module.css';

/**
 * Send a draft case to the reviewer. The server worked out `blockedReason` (a required item has no
 * file yet) and the API checks it again; the button stays closed while it is set, and the reason is
 * written beside it so it is not a mystery.
 */
export function SubmitForm({
  caseId,
  version,
  idempotencyKey,
  blockedReason,
  reloadHref,
}: {
  caseId: string;
  version: number;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  blockedReason: string | null;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<SubmitCaseState, FormData>(submitCaseAction, {
    key: idempotencyKey,
  });
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) summaryRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction} className={styles.decision}>
      <input type="hidden" name="caseId" value={caseId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          actions={state.reload ? <a href={reloadHref}>Reload this case</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      <div className={styles.buttons}>
        <Button
          type="submit"
          disabled={pending || blockedReason !== null}
          aria-describedby={blockedReason !== null ? 'submit-blocked' : undefined}
        >
          Submit for review
        </Button>
      </div>
      {blockedReason !== null ? (
        <p id="submit-blocked" className={styles.note}>
          {blockedReason}
        </p>
      ) : (
        <p className={styles.note}>
          After you submit, the documents are frozen for the reviewer. You cannot change them unless
          the case is rejected.
        </p>
      )}
      <p className={styles.status} role="status">
        {pending ? 'Submitting for review' : ''}
      </p>
    </form>
  );
}
