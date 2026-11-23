'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import {
  acceptAction,
  rejectAction,
  type RespondState,
} from '@/app/(portal)/quotations/[id]/actions';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';

import { Alert } from './alert';
import { Field, Input, Textarea } from './field';
import styles from './quotation.module.css';
import type { Respondability } from './quotation-status';
import { Checkbox } from '@/components/ui/checkbox';

/**
 * Accept or reject one quotation. A Client Component only so a refusal (409 stale, validation)
 * shows inline and keeps what the customer typed. Everything it submits goes to a server action,
 * so no token or API address is in the browser. When the quotation cannot be answered, the panel
 * says why, and for an expired one Accept stays visible but disabled, pointing at the reason.
 */
export function RespondPanel({
  quotationId,
  respondability,
  acceptKey,
  rejectKey,
  summary,
  reloadHref,
}: {
  quotationId: string;
  respondability: Respondability;
  /** UUIDs the server generated for this render, one per decision. */
  acceptKey: string;
  rejectKey: string;
  /** What the customer is accepting, in words, e.g. "QT-2082-0042 Rev 2 for USD 3,390.00". */
  summary: string;
  reloadHref: string;
}) {
  const reasonId = useId();

  if (!respondability.open) {
    return (
      <Card as="section" aria-labelledby={`${reasonId}-h`} className={styles.panel}>
        <h2 id={`${reasonId}-h`} className={styles.panelTitle}>
          Your response
        </h2>
        <Alert tone={respondability.expired ? 'warning' : 'info'} id={reasonId}>
          {respondability.reason}
        </Alert>
        {respondability.expired ? (
          <Button type="button" disabled aria-describedby={reasonId}>
            Accept quotation
          </Button>
        ) : null}
      </Card>
    );
  }

  return (
    <Card as="section" aria-labelledby={`${reasonId}-h`} className={styles.panel}>
      <h2 id={`${reasonId}-h`} className={styles.panelTitle}>
        Your response
      </h2>
      <AcceptForm
        quotationId={quotationId}
        idempotencyKey={acceptKey}
        summary={summary}
        reloadHref={reloadHref}
      />
      <details>
        <summary>Reject this quotation</summary>
        <RejectForm quotationId={quotationId} idempotencyKey={rejectKey} reloadHref={reloadHref} />
      </details>
    </Card>
  );
}

function ErrorSummary({ state, reloadHref }: { state: RespondState; reloadHref: string }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state.error) ref.current?.focus();
  }, [state]);
  if (!state.error) return null;
  return (
    <Alert
      ref={ref}
      tabIndex={-1}
      tone="error"
      role="alert"
      actions={
        // A plain link: a full reload is what guarantees the page shows the latest version.
        state.reload ? <a href={reloadHref}>Reload this quotation</a> : null
      }
    >
      {state.error}
    </Alert>
  );
}

function AcceptForm({
  quotationId,
  idempotencyKey,
  summary,
  reloadHref,
}: {
  quotationId: string;
  idempotencyKey: string;
  summary: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RespondState, FormData>(acceptAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action.
  const [name, setName] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const checkRef = useRef<HTMLButtonElement>(null);
  const checkId = useId();

  useEffect(() => {
    if (state.nameError) nameRef.current?.focus();
    else if (state.confirmError) checkRef.current?.focus();
  }, [state]);

  return (
    <form noValidate action={formAction} className={styles.form}>
      <input type="hidden" name="quotationId" value={quotationId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <ErrorSummary state={state} reloadHref={reloadHref} />

      <Field
        label="Your full name"
        hint="Typing your name signs this acceptance."
        error={state.nameError}
      >
        {(control) => (
          <Input
            ref={nameRef}
            name="acceptedByName"
            autoComplete="name"
            maxLength={200}
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            {...control}
          />
        )}
      </Field>

      <div>
        <label className={styles.check} htmlFor={checkId}>
          <Checkbox
            ref={checkRef}
            id={checkId}
            name="confirm"
            aria-required="true"
            checked={confirmed}
            onCheckedChange={(nextChecked) => setConfirmed(nextChecked)}
            aria-invalid={state.confirmError ? true : undefined}
            aria-describedby={state.confirmError ? `${checkId}-error` : undefined}
          />
          <span>I accept {summary} on the terms shown on this page.</span>
        </label>
        {state.confirmError ? (
          <span id={`${checkId}-error`} className={styles.checkError}>
            {state.confirmError}
          </span>
        ) : null}
      </div>

      <div className={styles.buttons}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Accepting…' : 'Accept quotation'}
        </Button>
      </div>
      <p className={styles.liveStatus} role="status">
        {pending ? 'Sending your acceptance' : ''}
      </p>
    </form>
  );
}

function RejectForm({
  quotationId,
  idempotencyKey,
  reloadHref,
}: {
  quotationId: string;
  idempotencyKey: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RespondState, FormData>(rejectAction, {
    key: idempotencyKey,
  });
  const [comment, setComment] = useState('');
  const commentRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (state.commentError) commentRef.current?.focus();
  }, [state]);

  return (
    <form noValidate action={formAction} className={styles.form}>
      <input type="hidden" name="quotationId" value={quotationId} />
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <ErrorSummary state={state} reloadHref={reloadHref} />

      <Field
        label="Why are you rejecting it?"
        hint="Your comment goes to the person who sent the quotation."
        error={state.commentError}
      >
        {(control) => (
          <Textarea
            ref={commentRef}
            name="comment"
            rows={4}
            maxLength={2000}
            required
            value={comment}
            onChange={(e) => setComment(e.target.value)}
            {...control}
          />
        )}
      </Field>

      <div className={styles.buttons}>
        <Button type="submit" variant="secondary" className={styles.danger} disabled={pending}>
          {pending ? 'Rejecting…' : 'Reject quotation'}
        </Button>
      </div>
      <p className={styles.liveStatus} role="status">
        {pending ? 'Sending your rejection' : ''}
      </p>
    </form>
  );
}
