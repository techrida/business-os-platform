'use client';

import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import styles from '../inbox.module.css';
import { decideAction, type DecisionState } from './actions';

/**
 * Approve, Return and Reject. A Client Component only so a refusal (403 reason, 409 stale) shows
 * inline next to the buttons and keeps the comment the person typed. Everything it submits goes to
 * a server action, so no token or API URL is in the browser.
 */
export function DecisionForm({
  requestId,
  version,
  idempotencyKey,
  reloadHref,
}: {
  requestId: string;
  version: number;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<DecisionState, FormData>(decideAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe the
  // comment when the API refuses and the person has to retype it.
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
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          actions={
            state.reload ? (
              // A plain link: a full reload is what guarantees the page shows the new version.
              <a href={reloadHref}>Reload this request</a>
            ) : null
          }
        >
          {state.error}
        </Alert>
      ) : null}

      <Field
        label="Comment"
        hint="Optional to approve. Required to return or reject."
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
        <Button type="submit" name="intent" value="approve" disabled={pending}>
          Approve
        </Button>
        <Button type="submit" name="intent" value="return" variant="secondary" disabled={pending}>
          Return for changes
        </Button>
        <Button
          type="submit"
          name="intent"
          value="reject"
          className={styles.danger}
          disabled={pending}
        >
          Reject
        </Button>
      </div>
      <p className={styles.status} role="status">
        {pending ? 'Sending your decision' : ''}
      </p>
    </form>
  );
}
