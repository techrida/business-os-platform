'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import { reviewAction, type ReviewState } from '../actions';
import styles from '../verification.module.css';

/**
 * Approve or reject a KYB case. A Client Component only so a refusal (403 reason, 409 stale) shows
 * inline next to the buttons and keeps the reason the person typed. It submits to a server action,
 * so no token or API URL is in the browser. The server worked out `canApprove` and `canReject`
 * from the case; the action and the API check them again.
 */
export function ReviewForm({
  caseId,
  version,
  idempotencyKey,
  canApprove,
  canReject,
  approveBlockedReason,
  reloadHref,
}: {
  caseId: string;
  version: number;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  canApprove: boolean;
  canReject: boolean;
  /** Why Approve is closed, in words, shown beside the buttons. */
  approveBlockedReason: string | null;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<ReviewState, FormData>(reviewAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe the
  // reason when the API refuses and the person has to retype it.
  const [comment, setComment] = useState('');
  const summaryRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Move focus to what went wrong, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (state.commentError) commentRef.current?.focus();
    else if (state.error) summaryRef.current?.focus();
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

      <Field
        label="Reason"
        hint="Required for both decisions. It is kept in the audit trail."
        error={state.commentError}
      >
        {(control) => (
          <Textarea
            ref={commentRef}
            name="comment"
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            rows={4}
            maxLength={2000}
            {...control}
          />
        )}
      </Field>

      <div className={styles.buttons}>
        <Button
          type="submit"
          name="intent"
          value="approve"
          disabled={pending || !canApprove}
          aria-describedby={approveBlockedReason ? 'approve-blocked' : undefined}
        >
          Approve customer
        </Button>
        <Button
          type="submit"
          name="intent"
          value="reject"
          className={styles.danger}
          disabled={pending || !canReject}
        >
          Reject
        </Button>
      </div>
      {approveBlockedReason ? (
        <p id="approve-blocked" className={styles.note}>
          {approveBlockedReason}
        </p>
      ) : null}
      <p className={styles.status} role="status">
        {pending ? 'Sending your decision' : ''}
      </p>
    </form>
  );
}
