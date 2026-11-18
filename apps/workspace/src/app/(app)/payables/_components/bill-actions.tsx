'use client';

import { useActionState, useRef, useState, type ReactNode } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/ui/transaction-dialog';
import actions from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';

import type { ActionState } from '../../procurement/orders/_lib/state';
import {
  matchBillAction,
  discardBillAction,
  rejectSubmissionAction,
  requestExceptionAction,
  submitBillAction,
  voidBillAction,
} from '../actions';

/**
 * The action dialogs of the bill page and the inbox: a trigger button and a native modal dialog
 * (focus trapped, Esc closes). The page makes one Idempotency-Key per render and the action returns
 * the key the next submit must use (kept after a timeout, rotated after a 4xx). Once the API
 * accepts, the dialog says what happened and closing it reloads the page with the new status.
 */

interface Common {
  /** The bill or submission the dialog acts on. */
  targetId: string;
  idempotencyKey: string;
  reloadHref: string;
  /** Names the thing in the title, such as the bill number. */
  label: string;
}

function Form({
  action,
  idField,
  common,
  submitLabel,
  pendingWords,
  tone = 'primary',
  fields,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  idField: 'billId' | 'submissionId';
  common: Common;
  submitLabel: string;
  pendingWords: string;
  tone?: 'primary' | 'secondary';
  fields?: (errors: Record<string, string>) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {
    key: common.idempotencyKey,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done !== undefined, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done !== undefined ? (
        <div className={actions.form}>
          <p role="status">{state.done} Close this to see the new status.</p>
          <div className={actions.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={actions.form}>
          <input type="hidden" name={idField} value={common.targetId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              actions={state.reload ? <a href={common.reloadHref}>Reload this page</a> : null}
            >
              {state.error}
            </Alert>
          ) : null}
          {fields?.(state.errors ?? {})}
          <div className={actions.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" variant={tone} disabled={pending}>
              {submitLabel}
            </Button>
          </div>
          <PendingLine pending={pending} words={pendingWords} />
        </form>
      )}
    </div>
  );
}

function ReasonField({
  errors,
  hint = 'The audit trail keeps this.',
}: {
  errors: Record<string, string>;
  hint?: string;
}) {
  const [reason, setReason] = useState('');
  return (
    <Field label="Reason" hint={hint} error={errors['reason']}>
      {(control) => (
        <Textarea
          name="reason"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          rows={3}
          maxLength={500}
          required
          {...control}
        />
      )}
    </Field>
  );
}

export function MatchDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Match again"
      title={`Match ${props.label}`}
      intro="Compares this bill with its purchase order and the receipts again, line by line. Use it after goods were received or the order changed. Nothing is approved by matching."
    >
      <Form
        action={matchBillAction}
        idField="billId"
        common={props}
        submitLabel="Match bill"
        pendingWords="Matching the bill"
        tone="secondary"
      />
    </ActionDialog>
  );
}

export function SubmitDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Submit for approval"
      triggerVariant="primary"
      title={`Submit ${props.label}`}
      intro="Sends the bill to its approvers. You cannot approve a bill you keyed in. Once submitted, the bill can no longer be matched or changed."
    >
      <Form
        action={submitBillAction}
        idField="billId"
        common={props}
        submitLabel="Submit for approval"
        pendingWords="Submitting the bill"
      />
    </ActionDialog>
  );
}

export function DiscardBillDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Discard draft"
      title={`Discard ${props.label}`}
      intro="Discarding keeps this draft in the audit trail and releases its invoice number for a replacement bill. This cannot be undone."
    >
      <Form
        action={discardBillAction}
        idField="billId"
        common={props}
        submitLabel="Discard draft"
        pendingWords="Discarding the draft bill"
        tone="secondary"
      />
    </ActionDialog>
  );
}

export function VoidDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Void bill"
      title={`Void ${props.label}`}
      intro="Voiding cancels an approved bill with a vendor debit note in the payables ledger. It cannot be undone, and it is refused once a payment is allocated or a payment request is open on the bill."
    >
      <Form
        action={voidBillAction}
        idField="billId"
        common={props}
        submitLabel="Void bill"
        pendingWords="Voiding the bill"
        tone="secondary"
        fields={(errors) => <ReasonField errors={errors} />}
      />
    </ActionDialog>
  );
}

export function RejectDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Reject"
      title={`Reject ${props.label}`}
      intro="Rejecting closes this submission without making a bill. The reason is kept with the submission."
    >
      <Form
        action={rejectSubmissionAction}
        idField="submissionId"
        common={props}
        submitLabel="Reject submission"
        pendingWords="Rejecting the submission"
        tone="secondary"
        fields={(errors) => <ReasonField errors={errors} hint="The audit trail keeps this." />}
      />
    </ActionDialog>
  );
}

function ExceptionFields({ errors }: { errors: Record<string, string> }) {
  const [reason, setReason] = useState('');
  const [evidence, setEvidence] = useState('');
  return (
    <>
      <Field label="Reason for the exception" error={errors['reason']}>
        {(control) => (
          <Textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={1000}
            rows={4}
            required
            {...control}
          />
        )}
      </Field>
      <Field
        label="Evidence document ID (optional)"
        hint="An existing document supporting the exception."
        error={errors['evidenceDocumentId']}
      >
        {(control) => (
          <Input
            name="evidenceDocumentId"
            value={evidence}
            onChange={(e) => setEvidence(e.target.value)}
            {...control}
          />
        )}
      </Field>
    </>
  );
}

export function ExceptionDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Request match exception"
      title={`Match exception for ${props.label}`}
      intro="Explain why Finance should accept the variance. The bill remains blocked until Finance approves the exception."
    >
      <Form
        action={requestExceptionAction}
        idField="billId"
        common={props}
        submitLabel="Send to Finance"
        pendingWords="Requesting the exception"
        fields={(errors) => <ExceptionFields errors={errors} />}
      />
    </ActionDialog>
  );
}
