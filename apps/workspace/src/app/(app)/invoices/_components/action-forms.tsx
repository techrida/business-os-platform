'use client';

import { useActionState, useRef, useState, type ReactNode, type RefObject } from 'react';

import {
  discardInvoiceAction,
  issueInvoiceAction,
  submitInvoiceAction,
  type InvoiceActionState,
} from '@/app/(app)/invoices/[id]/actions';
import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/ui/transaction-dialog';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import styles from './action-forms.module.css';

export interface InvoiceActionProps {
  invoiceId: string;
  /** The `version` of the invoice row the person is looking at. */
  version: number;
  /** What the dialog calls the invoice: its number, or its kind while it has none. */
  name: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/** What a refused action says, with a plain link to reload when the page is out of date. */
function ErrorSummary({
  error,
  reload,
  reloadHref,
  summaryRef,
}: {
  error: string | undefined;
  reload: boolean | undefined;
  reloadHref: string;
  summaryRef: RefObject<HTMLDivElement | null>;
}) {
  if (!error) return null;
  return (
    <Alert
      ref={summaryRef}
      tabIndex={-1}
      tone="error"
      role="alert"
      actions={reload ? <a href={reloadHref}>Reload this invoice</a> : null}
    >
      {error}
    </Alert>
  );
}

/**
 * The body every invoice action shares: hidden ids, the page's key and version, the refusal
 * summary, the buttons and the line that tells a screen reader the request is on its way. When the
 * API accepts, it says so and reloads the page once the dialog is closed, so the new status shows.
 */
function ActionBody({
  action,
  invoiceId,
  version,
  idempotencyKey,
  reloadHref,
  confirmLabel,
  pendingWords,
  fields,
}: Omit<InvoiceActionProps, 'name'> & {
  action: (prev: InvoiceActionState, form: FormData) => Promise<InvoiceActionState>;
  confirmLabel: string;
  pendingWords: string;
  /** Extra inputs, given the state so a field can show its own error. */
  fields?: (state: InvoiceActionState) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<InvoiceActionState, FormData>(action, {
    key: idempotencyKey,
  });
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status" className={styles.wrap}>
            {state.message} Close this to see the new status.
          </p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="invoiceId" value={invoiceId} />
          <input type="hidden" name="expectedVersion" value={version} />
          <input type="hidden" name="idempotencyKey" value={state.key} />

          <ErrorSummary
            error={state.error}
            reload={state.reload}
            reloadHref={reloadHref}
            summaryRef={summaryRef}
          />

          {fields?.(state)}

          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              {confirmLabel}
            </Button>
          </div>
          <PendingLine pending={pending} words={pendingWords} />
        </form>
      )}
    </div>
  );
}

/** Submit for approval: a draft or returned invoice goes to the approvers. */
export function SubmitDialog({ name, ...rest }: InvoiceActionProps) {
  return (
    <ActionDialog
      triggerLabel="Submit for approval"
      triggerVariant="primary"
      title={`Submit ${name}`}
      intro="The approvers are asked to review it. While it waits for their answer, its lines cannot be changed."
    >
      <ActionBody
        {...rest}
        action={submitInvoiceAction}
        confirmLabel="Submit for approval"
        pendingWords="Submitting the invoice"
      />
    </ActionDialog>
  );
}

/** Issue: the number and the date are set by the platform and cannot be changed afterwards. */
export function IssueDialog({
  name,
  kindLabel,
  ...rest
}: InvoiceActionProps & { kindLabel: string }) {
  const label = `Issue ${kindLabel.toLowerCase()}`;
  return (
    <ActionDialog
      triggerLabel={label}
      triggerVariant="primary"
      title={`Issue ${name}`}
      intro="Issuing gives it its number and today's date. The platform sets both, and neither can be changed afterwards."
    >
      <ActionBody
        {...rest}
        action={issueInvoiceAction}
        confirmLabel={label}
        pendingWords="Issuing the invoice"
      />
    </ActionDialog>
  );
}

/** Discard: final, and it needs a reason for the history. */
export function DiscardDialog({ name, ...rest }: InvoiceActionProps) {
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe what the
  // person typed when the API refuses.
  const [reason, setReason] = useState('');
  return (
    <ActionDialog
      triggerLabel="Discard"
      title={`Discard ${name}`}
      intro="A discarded invoice cannot be brought back. Say why, so the history makes sense."
    >
      <ActionBody
        {...rest}
        action={discardInvoiceAction}
        confirmLabel="Discard invoice"
        pendingWords="Discarding the invoice"
        fields={(state) => (
          <Field label="Reason" error={state.errors?.reason}>
            {(control) => (
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={1000}
                {...control}
              />
            )}
          </Field>
        )}
      />
    </ActionDialog>
  );
}
