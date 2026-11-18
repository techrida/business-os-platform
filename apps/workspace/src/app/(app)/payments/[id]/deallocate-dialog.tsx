'use client';

import { useActionState, useRef, useState } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/ui/transaction-dialog';
import styles from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import { deallocateAction, type AllocateState } from './allocate-actions';

export interface DeallocateDialogProps {
  paymentId: string;
  allocationId: string;
  /** The invoice's number (or a short id), so the trigger names what it undoes. */
  label: string;
  /** One UUID per allocation row, generated on the server for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Undoes one allocation as a reversal row, with a required reason. Offered by the page only on a
 * live allocation (not a reversal and not one already reversed); the server has the last word.
 */
export function DeallocateDialog({
  paymentId,
  allocationId,
  label,
  idempotencyKey,
  reloadHref,
}: DeallocateDialogProps) {
  return (
    <ActionDialog
      triggerLabel={`Deallocate ${label}`}
      title={`Deallocate ${label}`}
      intro="This adds a reversal row: the invoice's open amount goes back up and the credit returns to this payment. The original row stays in the list, and the reason is kept with the reversal."
    >
      <DeallocateBody
        paymentId={paymentId}
        allocationId={allocationId}
        idempotencyKey={idempotencyKey}
        reloadHref={reloadHref}
      />
    </ActionDialog>
  );
}

function DeallocateBody({
  paymentId,
  allocationId,
  idempotencyKey,
  reloadHref,
}: Omit<DeallocateDialogProps, 'label'>) {
  const [state, formAction, pending] = useActionState<AllocateState, FormData>(deallocateAction, {
    key: idempotencyKey,
  });
  // Controlled: React 19 resets uncontrolled fields after every action, which would wipe the reason
  // the person typed when the API refuses.
  const [reason, setReason] = useState('');
  const wrapRef = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);
  useFocusOnProblem(state, wrapRef, summaryRef);
  useReloadWhenClosed(state.done, wrapRef);

  return (
    <div ref={wrapRef}>
      {state.done === true ? (
        <div className={styles.form}>
          <p role="status">
            The allocation was reversed. Close this to see the updated allocations.
          </p>
          <div className={styles.buttons}>
            <DialogCloseButton variant="primary">Done</DialogCloseButton>
          </div>
        </div>
      ) : (
        <form action={formAction} className={styles.form}>
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="allocationId" value={allocationId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              actions={state.reload ? <a href={reloadHref}>Reload this payment</a> : null}
            >
              {state.error}
            </Alert>
          ) : null}
          <Field label="Reason for deallocating" error={state.errors?.reason}>
            {(control) => (
              <Textarea
                name="reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={4}
                maxLength={1000}
                required
                {...control}
              />
            )}
          </Field>
          <div className={styles.buttons}>
            <DialogCloseButton disabled={pending}>Cancel</DialogCloseButton>
            <Button type="submit" disabled={pending}>
              Deallocate
            </Button>
          </div>
          <PendingLine pending={pending} words="Deallocating" />
        </form>
      )}
    </div>
  );
}
