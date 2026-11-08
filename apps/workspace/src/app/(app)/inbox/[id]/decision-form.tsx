'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import styles from '../../kit.module.css';
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
  const commentId = useId();
  const hintId = useId();
  const errorId = useId();
  const summaryRef = useRef<HTMLDivElement>(null);
  const commentRef = useRef<HTMLTextAreaElement>(null);

  // Move focus to what went wrong, so a keyboard or screen reader user lands on it.
  useEffect(() => {
    if (state.commentError) commentRef.current?.focus();
    else if (state.error) summaryRef.current?.focus();
  }, [state]);

  return (
    <form action={formAction}>
      <input type="hidden" name="requestId" value={requestId} />
      <input type="hidden" name="expectedVersion" value={version} />
      <input type="hidden" name="idempotencyKey" value={state.key} />

      {state.error ? (
        <div
          ref={summaryRef}
          tabIndex={-1}
          role="alert"
          className={`${styles.notice} ${styles.noticeBad}`}
          style={{ marginBottom: '1rem' }}
        >
          <p>{state.error}</p>
          {state.reload ? (
            <p>
              {/* A plain link: a full reload is what guarantees the page shows the new version. */}
              <a href={reloadHref}>Reload this request</a>
            </p>
          ) : null}
        </div>
      ) : null}

      <div className={styles.field}>
        <label htmlFor={commentId} className={styles.label}>
          Comment
        </label>
        <span id={hintId} className={styles.hint}>
          Optional to approve. Required to return or reject.
        </span>
        <textarea
          ref={commentRef}
          id={commentId}
          name="comment"
          value={comment}
          onChange={(e) => setComment(e.target.value)}
          className={styles.input}
          rows={4}
          maxLength={2000}
          aria-describedby={state.commentError ? `${hintId} ${errorId}` : hintId}
          aria-invalid={state.commentError ? true : undefined}
        />
        {state.commentError ? (
          <span id={errorId} className={styles.fieldError}>
            {state.commentError}
          </span>
        ) : null}
      </div>

      <div className={styles.actions}>
        <button
          type="submit"
          name="intent"
          value="approve"
          className={styles.btn}
          disabled={pending}
        >
          Approve
        </button>
        <button
          type="submit"
          name="intent"
          value="return"
          className={`${styles.btn} ${styles.btnSecondary}`}
          disabled={pending}
        >
          Return for changes
        </button>
        <button
          type="submit"
          name="intent"
          value="reject"
          className={`${styles.btn} ${styles.btnDanger}`}
          disabled={pending}
        >
          Reject
        </button>
      </div>
      <p className={styles.hint} role="status" style={{ marginTop: '0.5rem' }}>
        {pending ? 'Sending your decision' : ''}
      </p>
    </form>
  );
}
