'use client';

import { useActionState, useId, useRef, useState, type ReactNode } from 'react';

import {
  ActionDialog,
  PendingLine,
  useFocusOnProblem,
} from '@/components/p2/quotations/action-dialog';
import actions from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { EvidenceUpload } from '@/components/ui/evidence-upload';
import { Field, Textarea } from '@/components/ui/field';

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
 * The action dialogs of the bill page and the inbox: a trigger button and a modal dialog
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
  triggerLabel,
  triggerVariant,
  title,
  intro,
  fields,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
  idField: 'billId' | 'submissionId';
  common: Common;
  submitLabel: string;
  pendingWords: string;
  triggerLabel: string;
  triggerVariant?: 'primary' | 'secondary';
  title: string;
  intro: string;
  /** `setBlocked` holds the submit button while a field is not ready (an evidence upload). */
  fields?: (errors: Record<string, string>, setBlocked: (blocked: boolean) => void) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<ActionState, FormData>(action, {
    key: common.idempotencyKey,
  });
  const [blocked, setBlocked] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  const formId = useId();

  return (
    <ActionDialog
      title={title}
      intro={intro}
      triggerLabel={triggerLabel}
      triggerVariant={triggerVariant ?? 'secondary'}
      formId={formId}
      pending={pending}
      done={state.done !== undefined}
      blocked={blocked}
      submitLabel={submitLabel}
    >
      <div ref={wrapRef}>
        {state.done !== undefined ? (
          <div className={actions.form}>
            <p role="status">{state.done} Close this to see the new status.</p>
          </div>
        ) : (
          <form noValidate id={formId} action={formAction} className={actions.form}>
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
            {fields?.(state.errors ?? {}, setBlocked)}
            <PendingLine pending={pending} words={pendingWords} />
          </form>
        )}
      </div>
    </ActionDialog>
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
    <Form
      triggerLabel="Match again"
      title={`Match ${props.label}`}
      intro="Compares this bill with its purchase order and the receipts again, line by line. Use it after goods were received or the order changed. Nothing is approved by matching."
      action={matchBillAction}
      idField="billId"
      common={props}
      submitLabel="Match bill"
      pendingWords="Matching the bill"
    />
  );
}

export function SubmitDialog(props: Common) {
  return (
    <Form
      triggerLabel="Submit for approval"
      triggerVariant="primary"
      title={`Submit ${props.label}`}
      intro="Sends the bill to its approvers. You cannot approve a bill you keyed in. Once submitted, the bill can no longer be matched or changed."
      action={submitBillAction}
      idField="billId"
      common={props}
      submitLabel="Submit for approval"
      pendingWords="Submitting the bill"
    />
  );
}

export function DiscardBillDialog(props: Common) {
  return (
    <Form
      triggerLabel="Discard draft"
      title={`Discard ${props.label}`}
      intro="Discarding keeps this draft in the audit trail and releases its invoice number for a replacement bill. This cannot be undone."
      action={discardBillAction}
      idField="billId"
      common={props}
      submitLabel="Discard draft"
      pendingWords="Discarding the draft bill"
    />
  );
}

export function VoidDialog(props: Common) {
  return (
    <Form
      triggerLabel="Void bill"
      title={`Void ${props.label}`}
      intro="Voiding cancels an approved bill with a vendor debit note in the payables ledger. It cannot be undone, and it is refused once a payment is allocated or a payment request is open on the bill."
      action={voidBillAction}
      idField="billId"
      common={props}
      submitLabel="Void bill"
      pendingWords="Voiding the bill"
      fields={(errors) => <ReasonField errors={errors} />}
    />
  );
}

export function RejectDialog(props: Common) {
  return (
    <Form
      triggerLabel="Reject"
      title={`Reject ${props.label}`}
      intro="Rejecting closes this submission without making a bill. The reason is kept with the submission."
      action={rejectSubmissionAction}
      idField="submissionId"
      common={props}
      submitLabel="Reject submission"
      pendingWords="Rejecting the submission"
      fields={(errors) => <ReasonField errors={errors} hint="The audit trail keeps this." />}
    />
  );
}

function ExceptionFields({
  billId,
  errors,
  onBlockingChange,
}: {
  billId: string;
  errors: Record<string, string>;
  onBlockingChange: (blocked: boolean) => void;
}) {
  const [reason, setReason] = useState('');
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
      <EvidenceUpload
        kind="vendor-bill"
        ownerId={billId}
        name="evidenceDocumentId"
        label="Evidence"
        optional
        hint="A document supporting the exception, such as the vendor's agreement to the price."
        error={errors['evidenceDocumentId']}
        onBlockingChange={onBlockingChange}
      />
    </>
  );
}

export function ExceptionDialog(props: Common) {
  return (
    <Form
      triggerLabel="Request match exception"
      title={`Match exception for ${props.label}`}
      intro="Explain why Finance should accept the variance. The bill remains blocked until Finance approves the exception."
      action={requestExceptionAction}
      idField="billId"
      common={props}
      submitLabel="Send to Finance"
      pendingWords="Requesting the exception"
      fields={(errors, setBlocked) => (
        <ExceptionFields billId={props.targetId} errors={errors} onBlockingChange={setBlocked} />
      )}
    />
  );
}
