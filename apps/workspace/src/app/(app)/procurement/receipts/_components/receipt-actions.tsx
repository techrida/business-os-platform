'use client';

import { useState } from 'react';

import { Field, Textarea } from '@/components/ui/field';

import { confirmReceiptAction, reverseReceiptAction, discardReceiptAction } from '../actions';

import { ProcurementActionDialog } from '../../action-dialog';

interface Common {
  receiptId: string;
  number: string;
  idempotencyKey: string;
  reloadHref: string;
}

export function ConfirmDialog(props: Common) {
  return (
    <ProcurementActionDialog
      triggerLabel="Confirm receipt"
      triggerVariant="primary"
      title={`Confirm ${props.number}`}
      intro="Confirming makes the quantities final: the purchase order then counts them as received. A confirmed receipt cannot be edited, only reversed."
      action={confirmReceiptAction}
      idempotencyKey={props.idempotencyKey}
      recordField="receiptId"
      recordId={props.receiptId}
      reloadHref={props.reloadHref}
      reloadLabel="Reload this receipt"
      submitLabel="Confirm receipt"
      pendingWords="Confirming the receipt"
    />
  );
}

export function DiscardReceiptDialog(props: Common) {
  return (
    <ProcurementActionDialog
      triggerLabel="Discard draft"
      title={`Discard ${props.number}`}
      intro="Discarding releases the quantities reserved by this draft so another receipt can use them. The draft stays in the audit trail. This cannot be undone."
      action={discardReceiptAction}
      idempotencyKey={props.idempotencyKey}
      recordField="receiptId"
      recordId={props.receiptId}
      reloadHref={props.reloadHref}
      reloadLabel="Reload this receipt"
      submitLabel="Discard draft"
      pendingWords="Discarding the draft receipt"
      submitVariant="secondary"
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

export function ReverseDialog(props: Common) {
  return (
    <ProcurementActionDialog
      triggerLabel="Reverse receipt"
      title={`Reverse ${props.number}`}
      intro="Reversing records a new receipt with the same lines as negative quantities, so what arrived counts as not received again. This receipt stays as it is, marked reversed. It cannot be undone: if the goods arrive again, make a new receipt."
      action={reverseReceiptAction}
      idempotencyKey={props.idempotencyKey}
      recordField="receiptId"
      recordId={props.receiptId}
      reloadHref={props.reloadHref}
      reloadLabel="Reload this receipt"
      submitLabel="Reverse receipt"
      pendingWords="Reversing the receipt"
      submitVariant="secondary"
      fields={(errors) => <ReasonField errors={errors} />}
    />
  );
}
