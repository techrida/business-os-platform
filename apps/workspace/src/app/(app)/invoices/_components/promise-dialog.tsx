'use client';

import { useActionState, useEffect, useId, useRef, useState } from 'react';

import {
  recordPromiseAction,
  type PromiseActionState,
} from '@/app/(app)/invoices/[id]/promise-actions';
import { useFocusOnProblem, useRefreshAfterAction } from '@/components/p2/quotations/action-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';

import styles from './promise-card.module.css';
import { Tooltip } from '@/components/ui/tooltip';

export interface PromiseDialogProps {
  invoiceId: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Today in Kathmandu, from the server: the earliest day a customer can promise. */
  today: string;
  /** The open promise's date, formatted, when recording replaces it; null when none is open. */
  replacing: string | null;
  reloadHref: string;
}

/**
 * Record a promise to pay: the day the customer said they will pay, and an optional note. Keyed on the render's
 * idempotency key, so the refresh after a success starts a fresh form instead of keeping "done".
 */
export function PromiseDialog(props: PromiseDialogProps) {
  return <PromiseForm key={props.idempotencyKey} {...props} />;
}

function PromiseForm({
  invoiceId,
  idempotencyKey,
  today,
  replacing,
  reloadHref,
}: PromiseDialogProps) {
  const [state, formAction, pending] = useActionState<PromiseActionState, FormData>(
    recordPromiseAction,
    { key: idempotencyKey },
  );
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe them on a refusal.
  const [promisedDate, setPromisedDate] = useState('');
  const [note, setNote] = useState('');
  const refreshAfterAction = useRefreshAfterAction();
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);
  useEffect(() => {
    if (state.done) toast.success(state.message ?? 'Promise to pay recorded.', { id: state.key });
    else if (state.error || state.errors) toast.error('Check the promise to pay');
  }, [state]);

  return (
    <Dialog
      trigger={<Button variant="secondary">Record promise</Button>}
      title="Record a promise to pay"
      description={
        state.done
          ? undefined
          : replacing !== null
            ? `This replaces the promise for ${replacing}.`
            : 'The day the customer said they will pay. If it passes with money still owed, a collection call is planned.'
      }
      size="small"
      locked={pending}
      closeOnOutsideClick={false}
      onOpenChange={(open) => {
        // A refresh after success shows the new promise and its history together.
        if (!open && state.done) refreshAfterAction();
      }}
      footer={
        state.done ? (
          <DialogClose asChild>
            <Button>Done</Button>
          </DialogClose>
        ) : (
          <>
            <DialogClose asChild>
              <Button variant="secondary" disabled={pending}>
                Cancel
              </Button>
            </DialogClose>
            <Button type="submit" form={formId} disabled={pending}>
              {pending ? 'Recording' : 'Record promise'}
            </Button>
          </>
        )
      }
    >
      {state.done ? null : (
        <form id={formId} ref={formRef} action={formAction} noValidate className={styles.form}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              actions={state.reload ? <a href={reloadHref}>Reload this invoice</a> : null}
            >
              {state.error}
            </Alert>
          ) : null}
          <Field label="Promised date" error={state.errors?.promisedDate}>
            {(control) => (
              <DatePicker
                name="promisedDate"
                required
                min={today}
                value={promisedDate}
                onChange={setPromisedDate}
                {...control}
              />
            )}
          </Field>
          <Field label="Note" optional error={state.errors?.note}>
            {(control) => (
              <Textarea
                name="note"
                value={note}
                onChange={(e) => setNote(e.target.value)}
                rows={3}
                maxLength={1000}
                {...control}
              />
            )}
          </Field>
          <p className="sr-only" role="status">
            {pending ? 'Recording' : ''}
          </p>
        </form>
      )}
    </Dialog>
  );
}

/**
 * Record promise, shown but off, with the plain reason in a tooltip (UIP-FORM-011, no text beside it). The button stays in the tab order with
 * `aria-disabled` (a natively disabled button cannot be focused, so its reason would never be read out).
 */
export function PromiseBlocked({ reason }: { reason: string }) {
  return (
    <Tooltip content={reason}>
      <Button variant="secondary" aria-disabled="true" onClick={(e) => e.preventDefault()}>
        Record promise
      </Button>
    </Tooltip>
  );
}
