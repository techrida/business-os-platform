'use client';

import { useActionState, useRef, useState, type ReactNode } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/p2/quotations/action-dialog';
import actions from '@/components/p2/quotations/actions.module.css';
import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, Textarea } from '@/components/ui/field';

import type { ActionState } from '../../orders/_lib/state';
import { confirmReceiptAction, reverseReceiptAction, discardReceiptAction } from '../actions';

/**
 * The action dialogs of the receipt page: a trigger button and a native modal dialog (focus
 * trapped, Esc closes). The page makes one Idempotency-Key per render and the action returns the
 * key the next submit must use (kept after a timeout, rotated after a 4xx). Once the API accepts,
 * the dialog says what happened and closing it reloads the page with the new status.
 */

interface Common {
  receiptId: string;
  number: string;
  idempotencyKey: string;
  reloadHref: string;
}

function Form({
  action,
  common,
  submitLabel,
  pendingWords,
  tone = 'primary',
  fields,
}: {
  action: (prev: ActionState, form: FormData) => Promise<ActionState>;
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
          <input type="hidden" name="receiptId" value={common.receiptId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          {state.error ? (
            <Alert
              ref={summaryRef}
              tabIndex={-1}
              tone="error"
              role="alert"
              actions={state.reload ? <a href={common.reloadHref}>Reload this receipt</a> : null}
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

export function ConfirmDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Confirm receipt"
      triggerVariant="primary"
      title={`Confirm ${props.number}`}
      intro="Confirming makes the quantities final: the purchase order then counts them as received. A confirmed receipt cannot be edited, only reversed."
    >
      <Form
        action={confirmReceiptAction}
        common={props}
        submitLabel="Confirm receipt"
        pendingWords="Confirming the receipt"
      />
    </ActionDialog>
  );
}

export function DiscardReceiptDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Discard draft"
      title={`Discard ${props.number}`}
      intro="Discarding releases the quantities reserved by this draft so another receipt can use them. The draft stays in the audit trail. This cannot be undone."
    >
      <Form
        action={discardReceiptAction}
        common={props}
        submitLabel="Discard draft"
        pendingWords="Discarding the draft receipt"
        tone="secondary"
      />
    </ActionDialog>
  );
}

function ReasonField({ errors }: { errors: Record<string, string> }) {
  const [reason, setReason] = useState('');
  return (
    <Field label="Reason" hint="The audit trail keeps this." error={errors['reason']}>
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

export function ReverseDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Reverse receipt"
      title={`Reverse ${props.number}`}
      intro="Reversing records a new receipt with the same lines as negative quantities, so what arrived counts as not received again. This receipt stays as it is, marked reversed. It cannot be undone: if the goods arrive again, make a new receipt."
    >
      <Form
        action={reverseReceiptAction}
        common={props}
        submitLabel="Reverse receipt"
        pendingWords="Reversing the receipt"
        tone="secondary"
        fields={(errors) => <ReasonField errors={errors} />}
      />
    </ActionDialog>
  );
}
