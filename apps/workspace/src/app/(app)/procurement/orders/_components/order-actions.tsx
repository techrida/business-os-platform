'use client';

import { useActionState, useRef, useState, type ReactNode } from 'react';

import {
  ActionDialog,
  DialogCloseButton,
  ErrorSummary,
  PendingLine,
  useFocusOnProblem,
  useReloadWhenClosed,
} from '@/components/p2/quotations/action-dialog';
import actions from '@/components/p2/quotations/actions.module.css';
import { Button } from '@/components/ui/button';
import { Field, Input, Textarea } from '@/components/ui/field';

import { amendAction, cancelAction, issueAction, shortCloseAction } from '../actions';
import { qtyText } from '../_lib/model';
import type { ActionState } from '../_lib/state';
import styles from '../orders.module.css';

/**
 * The action dialogs of the purchase order page. Each is a trigger button and a native modal
 * dialog (focus trapped, Esc closes). The page makes one Idempotency-Key per render and the action
 * returns the key the next submit must use (kept after a timeout, rotated after a 4xx). Once the
 * API accepts, the dialog says what happened and closing it reloads the page with the new status.
 */

interface Common {
  purchaseOrderId: string;
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
          <input type="hidden" name="purchaseOrderId" value={common.purchaseOrderId} />
          <input type="hidden" name="idempotencyKey" value={state.key} />
          <ErrorSummary
            error={state.error}
            reload={state.reload}
            reloadHref={common.reloadHref}
            reloadLabel="Reload this purchase order"
            summaryRef={summaryRef}
          />
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

export function IssueDialog(props: Common) {
  return (
    <ActionDialog
      triggerLabel="Issue purchase order"
      triggerVariant="primary"
      title={`Issue ${props.number}`}
      intro="Issuing makes version 1 final and gives it a PDF. The vendor must be approved and have an active account with your legal entity. It cannot be undone, only amended."
    >
      <Form
        action={issueAction}
        common={props}
        submitLabel="Issue purchase order"
        pendingWords="Issuing the purchase order"
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

export function ReasonDialog({ kind, ...common }: Common & { kind: 'shortClose' | 'cancel' }) {
  const cancel = kind === 'cancel';
  return (
    <ActionDialog
      triggerLabel={cancel ? 'Cancel order' : 'Short-close'}
      title={`${cancel ? 'Cancel' : 'Short-close'} ${common.number}`}
      intro={
        cancel
          ? 'Cancelling stops the order before anything is received. Discard any draft receipt from its detail page first. Once a receipt is confirmed, short-close the order instead.'
          : 'Short-closing accepts what has arrived and stops waiting for the rest. A draft receipt still open on the order must be confirmed or discarded from its detail page first.'
      }
    >
      <Form
        action={cancel ? cancelAction : shortCloseAction}
        common={common}
        submitLabel={cancel ? 'Cancel order' : 'Short-close order'}
        pendingWords={cancel ? 'Cancelling the order' : 'Short-closing the order'}
        tone="secondary"
        fields={(errors) => <ReasonField errors={errors} />}
      />
    </ActionDialog>
  );
}

export interface AmendLine {
  id: string;
  lineNo: number;
  description: string;
  uom: string;
  orderedQuantity: string;
  unitPrice: string;
  /** Received so far; null when the progress could not be read. */
  received: string | null;
  cancelledQuantity: string;
}

function AmendFields({
  lines,
  paymentTermsDays,
  currency,
  errors,
}: {
  lines: readonly AmendLine[];
  paymentTermsDays: number;
  currency: string;
  errors: Record<string, string>;
}) {
  // Controlled, so a refusal does not wipe what the person typed.
  const [values, setValues] = useState(() =>
    Object.fromEntries(
      lines.map((l) => [l.id, { quantity: qtyText(l.orderedQuantity), unitPrice: l.unitPrice }]),
    ),
  );
  const [terms, setTerms] = useState(String(paymentTermsDays));
  const [reason, setReason] = useState('');
  const set = (id: string, field: 'quantity' | 'unitPrice', value: string): void =>
    setValues((v) => ({ ...v, [id]: { quantity: '', unitPrice: '', ...v[id], [field]: value } }));

  return (
    <>
      {errors['lines'] ? (
        <p role="alert" className={styles.fieldError}>
          {errors['lines']}
        </p>
      ) : null}
      {lines.map((l) => (
        <fieldset key={l.id} className={styles.lineGroup}>
          <legend>
            Line {l.lineNo}: {l.description}
          </legend>
          <p className={styles.note}>
            Ordered {qtyText(l.orderedQuantity)} {l.uom} at {currency} {l.unitPrice}
            {l.received !== null ? `. ${qtyText(l.received)} received` : ''}
            {l.cancelledQuantity !== '0.0000' ? `, ${qtyText(l.cancelledQuantity)} cancelled` : ''}.
            The quantity cannot go below what has been received plus cancelled.
          </p>
          <div className={styles.lineFields}>
            <Field label="Quantity" error={errors[`${l.id}.quantity`]}>
              {(control) => (
                <Input
                  name={`qty:${l.id}`}
                  value={values[l.id]?.quantity ?? ''}
                  onChange={(e) => set(l.id, 'quantity', e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  className={styles.numeric}
                  {...control}
                />
              )}
            </Field>
            <Field label={`Unit price (${currency})`} error={errors[`${l.id}.unitPrice`]}>
              {(control) => (
                <Input
                  name={`price:${l.id}`}
                  value={values[l.id]?.unitPrice ?? ''}
                  onChange={(e) => set(l.id, 'unitPrice', e.target.value)}
                  inputMode="decimal"
                  autoComplete="off"
                  className={styles.numeric}
                  {...control}
                />
              )}
            </Field>
          </div>
        </fieldset>
      ))}
      <Field
        label="Payment terms (days)"
        hint="Optional. Sent only if you change it."
        error={errors['paymentTermsDays']}
      >
        {(control) => (
          <Input
            name="paymentTerms"
            value={terms}
            onChange={(e) => setTerms(e.target.value)}
            inputMode="numeric"
            autoComplete="off"
            className={styles.numeric}
            {...control}
          />
        )}
      </Field>
      <Field
        label="Reason"
        hint="Why the order changes. The audit trail keeps this."
        error={errors['reason']}
      >
        {(control) => (
          <Textarea
            name="reason"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            rows={3}
            maxLength={1000}
            required
            {...control}
          />
        )}
      </Field>
    </>
  );
}

export function AmendDialog({
  lines,
  paymentTermsDays,
  currency,
  ...common
}: Common & { lines: readonly AmendLine[]; paymentTermsDays: number; currency: string }) {
  return (
    <ActionDialog
      triggerLabel="Amend order"
      title={`Amend ${common.number}`}
      intro="Change a quantity or price. If the new total falls in a higher approval band, the order waits for approval and keeps its current version until then. Otherwise the change becomes the next version straight away."
    >
      <Form
        action={amendAction}
        common={common}
        submitLabel="Submit amendment"
        pendingWords="Submitting the amendment"
        fields={(errors) => (
          <AmendFields
            lines={lines}
            paymentTermsDays={paymentTermsDays}
            currency={currency}
            errors={errors}
          />
        )}
      />
    </ActionDialog>
  );
}
