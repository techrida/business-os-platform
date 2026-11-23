'use client';

import {
  useActionState,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react';

import {
  discardInvoiceAction,
  editInvoiceDueDateAction,
  issueInvoiceAction,
  reopenInvoiceAction,
  submitInvoiceAction,
  type InvoiceActionState,
} from '@/app/(app)/invoices/[id]/actions';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Textarea } from '@/components/ui/field';
import { toast } from '@/components/ui/toast';
import { useFocusOnProblem } from '@/components/p2/quotations/action-dialog';

import dialogStyles from '@/components/p3/transaction-form-dialog.module.css';

import styles from './action-forms.module.css';
import { Tooltip } from '@/components/ui/tooltip';

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
  destructive = !primary,
  fields,
  doneWords,
}: Omit<InvoiceActionProps, 'name'> & {
  action: (prev: InvoiceActionState, form: FormData) => Promise<InvoiceActionState>;
  triggerLabel: string;
  confirmLabel?: string;
  title: string;
  description: string;
  pendingWords: string;
  primary?: boolean;
  /** A secondary action that is not a loss (Edit due date) sets this false; it defaults to "not primary". */
  destructive?: boolean;
  fields?: (state: InvoiceActionState) => ReactNode;
  /** Said under the result once the action is done: the invoice's new status and what follows. */
  doneWords?: string;
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
    else if (state.error || state.errors?.reason || state.errors?.dueDate) {
      toast.error('Check the invoice action');
    }
  }, [state]);

  return (
    <Dialog
      trigger={<Button variant={primary ? 'primary' : 'secondary'}>{triggerLabel}</Button>}
      title={title}
      description={state.done ? undefined : description}
      tone={destructive ? 'destructive' : 'default'}
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
              className={destructive ? dialogStyles.danger : undefined}
            >
              {pending ? pendingWords : (confirmLabel ?? triggerLabel)}
            </Button>
          </>
        )
      }
    >
      {state.done ? (
        // The toast may be gone by the time the person looks, so the dialog keeps the result until Done.
        <div className={styles.done}>
          <p className={styles.doneResult}>{state.message ?? 'The invoice was updated.'}</p>
          {doneWords ? <p>{doneWords}</p> : null}
          <p className={styles.doneNext}>Done closes this and shows the updated invoice.</p>
        </div>
      ) : (
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
      doneWords="It is now awaiting approval, and its line items stay locked while the approvers review it."
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
      doneWords="Its number and date are set and cannot be changed."
    />
  );
}

/**
 * An action shown but off, with the reason. The button stays in the tab order with `aria-disabled` (a natively
 * disabled button cannot be focused, so its reason would never be read out); the reason sits under it, linked with
 * `aria-describedby`, and is its tooltip. A click does nothing.
 */
function ActionBlocked({
  label,
  reason,
  primary = false,
}: {
  label: string;
  reason: string;
  primary?: boolean;
}) {
  return (
    <Tooltip content={reason}>
      <Button
        variant={primary ? 'primary' : 'secondary'}
        aria-disabled="true"
        onClick={(e) => e.preventDefault()}
      >
        {label}
      </Button>
    </Tooltip>
  );
}

/** Issue, shown but off: the person created this credit or debit note, and its issuer must be someone else (TR-Q12f). */
export function IssueBlocked({ kindLabel, reason }: { kindLabel: string; reason: string }) {
  return <ActionBlocked label={`Issue ${kindLabel.toLowerCase()}`} reason={reason} primary />;
}

/** Edit due date, shown but off: the API's reason (an order's invoice or a note takes its due date at issue). */
export function EditDueDateBlocked({ reason }: { reason: string }) {
  return <ActionBlocked label="Edit due date" reason={reason} />;
}

/**
 * Edit due date on a draft or returned invoice. `dueDate` is the stored ISO date (or null), `dueDateText` the same day
 * as the page writes it (AD with its BS form). The picker sends ISO; the server refuses a day before today.
 */
export function EditDueDateDialog({
  name,
  dueDate,
  dueDateText,
  ...rest
}: InvoiceActionProps & { dueDate: string | null; dueDateText: string | null }) {
  // Controlled, so a refusal never wipes the picked date (React 19 resets uncontrolled fields).
  const [value, setValue] = useState(dueDate ?? '');
  // The calendar opens inside the dialog, so it stays in its focus and stacking boundary.
  const [container, setContainer] = useState<HTMLElement>();
  const connect = useCallback((el: HTMLDivElement | null) => {
    setContainer(el?.closest<HTMLElement>('[role="dialog"]') ?? undefined);
  }, []);
  return (
    <InvoiceActionDialog
      {...rest}
      action={editInvoiceDueDateAction}
      triggerLabel="Edit due date"
      confirmLabel="Save due date"
      destructive={false}
      title={`Edit the due date of ${name}`}
      description={
        dueDateText === null
          ? 'This invoice has no due date yet.'
          : `The due date is now ${dueDateText}.`
      }
      pendingWords="Saving"
      fields={(state) => (
        <div ref={connect}>
          <Field label="New due date" error={state.errors?.dueDate}>
            {(control) => (
              <DatePicker
                name="dueDate"
                value={value}
                onChange={setValue}
                popoverContainer={container}
                required
                {...control}
              />
            )}
          </Field>
        </div>
      )}
    />
  );
}

/**
 * What happens to the due date of an invoice taken back to draft, by the due-date route's rule: a manual tax invoice's
 * can be edited; an order's invoice and a debit note take theirs when issued; a credit note has none of its own.
 */
export type ReopenedDueDate = 'editable' | 'set_at_issue' | 'none';

const REOPEN_WORDS: Record<ReopenedDueDate, string> = {
  editable:
    'Its approval will no longer count. As a draft, its due date can be changed, and then it must be submitted for approval again before it is issued. The reason stays in its history.',
  set_at_issue:
    'Its approval will no longer count, and it must be submitted for approval again before it is issued. Its due date is set when it is issued. The reason stays in its history.',
  none: 'Its approval will no longer count, and it must be submitted for approval again before it is issued. The reason stays in its history.',
};

/**
 * Back to draft: the approval no longer counts (the approved request stays decided; submitting again opens a new one),
 * and it needs a reason for the history.
 */
export function ReopenDialog({
  name,
  dueDate,
  ...rest
}: InvoiceActionProps & { dueDate: ReopenedDueDate }) {
  const [reason, setReason] = useState('');
  return (
    <InvoiceActionDialog
      {...rest}
      action={reopenInvoiceAction}
      triggerLabel="Back to draft"
      confirmLabel="Move to draft"
      title={`Move ${name} back to draft`}
      description={REOPEN_WORDS[dueDate]}
      pendingWords="Moving"
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
