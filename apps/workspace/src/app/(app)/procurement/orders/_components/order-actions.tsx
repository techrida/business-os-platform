'use client';

import { useState } from 'react';

import { Field, Input, Textarea } from '@/components/ui/field';

import { amendAction, cancelAction, issueAction, shortCloseAction } from '../actions';
import { qtyText } from '../_lib/model';
import styles from '../orders.module.css';

import { ProcurementActionDialog } from '../../action-dialog';

interface Common {
  purchaseOrderId: string;
  number: string;
  idempotencyKey: string;
  reloadHref: string;
}

export function IssueDialog(props: Common) {
  return (
    <ProcurementActionDialog
      triggerLabel="Issue purchase order"
      triggerVariant="primary"
      title={`Issue ${props.number}`}
      intro="Issuing makes version 1 final and gives it a PDF. The vendor must be approved and have an active account with your legal entity. It cannot be undone, only amended."
      action={issueAction}
      idempotencyKey={props.idempotencyKey}
      recordField="purchaseOrderId"
      recordId={props.purchaseOrderId}
      reloadHref={props.reloadHref}
      reloadLabel="Reload this purchase order"
      submitLabel="Issue purchase order"
      pendingWords="Issuing the purchase order"
    />
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
    <ProcurementActionDialog
      triggerLabel={cancel ? 'Cancel order' : 'Short-close'}
      title={`${cancel ? 'Cancel' : 'Short-close'} ${common.number}`}
      intro={
        cancel
          ? 'Cancelling stops the order before anything is received. Discard any draft receipt from its detail page first. Once a receipt is confirmed, short-close the order instead.'
          : 'Short-closing accepts what has arrived and stops waiting for the rest. A draft receipt still open on the order must be confirmed or discarded from its detail page first.'
      }
      action={cancel ? cancelAction : shortCloseAction}
      idempotencyKey={common.idempotencyKey}
      recordField="purchaseOrderId"
      recordId={common.purchaseOrderId}
      reloadHref={common.reloadHref}
      reloadLabel="Reload this purchase order"
      submitLabel={cancel ? 'Cancel order' : 'Short-close order'}
      pendingWords={cancel ? 'Cancelling the order' : 'Short-closing the order'}
      submitVariant="secondary"
      fields={(errors) => <ReasonField errors={errors} />}
    />
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
    <ProcurementActionDialog
      size="large"
      triggerLabel="Amend order"
      title={`Amend ${common.number}`}
      intro="Change a quantity, a price or the payment terms. If the total goes up or the payment terms change, the order waits for approval and keeps its current version until then. Any other change becomes the next version straight away."
      action={amendAction}
      idempotencyKey={common.idempotencyKey}
      recordField="purchaseOrderId"
      recordId={common.purchaseOrderId}
      reloadHref={common.reloadHref}
      reloadLabel="Reload this purchase order"
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
  );
}
