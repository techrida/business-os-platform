'use client';

import {
  useActionState,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import {
  discardInvoiceAction,
  issueInvoiceAction,
  submitInvoiceAction,
  type InvoiceActionState,
} from '@/app/(app)/invoices/[id]/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { useFocusOnProblem } from '@/components/p2/quotations/action-dialog';

import dialogStyles from '@/components/p3/transaction-form-dialog.module.css';

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

/** The invoice dialogs keep the original version and idempotency key through a refused action. */
function InvoiceActionDialog({
  action,
  invoiceId,
  version,
  idempotencyKey,
  reloadHref,
  triggerLabel,
  confirmLabel,
  title,
  description,
  pendingWords,
  primary = false,
  fields,
}: Omit<InvoiceActionProps, 'name'> & {
  action: (prev: InvoiceActionState, form: FormData) => Promise<InvoiceActionState>;
  triggerLabel: string;
  confirmLabel?: string;
  title: string;
  description: string;
  pendingWords: string;
  primary?: boolean;
  fields?: (state: InvoiceActionState) => ReactNode;
}) {
  const [state, formAction, pending] = useActionState<InvoiceActionState, FormData>(action, {
    key: idempotencyKey,
  });
  const formId = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, formRef, summaryRef);
  useEffect(() => {
    if (state.done) toast.success(state.message ?? 'Invoice updated', { id: state.key });
    else if (state.error || state.errors?.reason) toast.error('Check the invoice action');
  }, [state]);

  return (
    <Dialog
      trigger={<Button variant={primary ? 'primary' : 'secondary'}>{triggerLabel}</Button>}
      title={title}
      description={state.done ? undefined : description}
      tone={primary ? 'default' : 'destructive'}
      size="small"
      locked={pending}
      closeOnOutsideClick={false}
      onOpenChange={(open) => {
        // A full reload after success replaces the detail and its expected version together.
        if (!open && state.done) window.location.reload();
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
            <Button
              type="submit"
              form={formId}
              disabled={pending}
              className={primary ? undefined : dialogStyles.danger}
            >
              {pending ? pendingWords : (confirmLabel ?? triggerLabel)}
            </Button>
          </>
        )
      }
    >
      {state.done ? null : (
        <form id={formId} ref={formRef} action={formAction} noValidate className={styles.form}>
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
          <p className="sr-only" role="status">
            {pending ? pendingWords : ''}
          </p>
        </form>
      )}
    </Dialog>
  );
}

/** Submit for approval: a draft or returned invoice goes to the approvers. */
export function SubmitDialog({ name, ...rest }: InvoiceActionProps) {
  return (
    <InvoiceActionDialog
      {...rest}
      action={submitInvoiceAction}
      triggerLabel="Submit for approval"
      primary
      title={`Submit ${name}`}
      description="Send this invoice to the approvers. Its line items will be locked during review."
      pendingWords="Submitting"
    />
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
    <InvoiceActionDialog
      {...rest}
      action={issueInvoiceAction}
      triggerLabel={label}
      primary
      title={`Issue ${name}`}
      description="Issuing assigns the invoice number and today's date. Afterwards, neither can be changed."
      pendingWords="Issuing"
    />
  );
}

/**
 * Issue, shown but off: the person created this credit or debit note, and its issuer must be someone else (TR-Q12f).
 * The button stays in the tab order with `aria-disabled` (a natively disabled button cannot be focused, so its reason
 * would never be read out); the reason sits under it, linked with `aria-describedby`, and is its tooltip. A click does
 * nothing.
 */
export function IssueBlocked({ kindLabel, reason }: { kindLabel: string; reason: string }) {
  const reasonId = useId();
  return (
    <div className={styles.blocked}>
      <Button
        variant="primary"
        aria-disabled="true"
        aria-describedby={reasonId}
        title={reason}
        onClick={(e) => e.preventDefault()}
      >
        {`Issue ${kindLabel.toLowerCase()}`}
      </Button>
      <p id={reasonId} className={styles.blockedReason}>
        {reason}
      </p>
    </div>
  );
}

/** Discard: final, and it needs a reason for the history. */
export function DiscardDialog({ name, ...rest }: InvoiceActionProps) {
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe what the
  // person typed when the API refuses.
  const [reason, setReason] = useState('');
  return (
    <InvoiceActionDialog
      {...rest}
      action={discardInvoiceAction}
      triggerLabel="Discard"
      confirmLabel="Discard invoice"
      title={`Discard ${name}`}
      description="A discarded invoice cannot be brought back. The reason stays in its history."
      pendingWords="Discarding"
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
  );
}
