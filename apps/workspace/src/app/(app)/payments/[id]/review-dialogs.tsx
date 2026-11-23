'use client';

import { useState } from 'react';

import { Field, Textarea } from '@/components/ui/field';

import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';
import type { PaymentActions } from '../_lib/status';
import { rejectAction, reverseAction, verifyAction, type ReviewState } from './review-actions';

export interface ReviewDialogsProps {
  paymentId: string;
  version: number;
  number: string | null;
  actions: PaymentActions;
  keys: { verify: string; reject: string; reverse: string };
}

export function ReviewDialogs({ paymentId, version, number, actions, keys }: ReviewDialogsProps) {
  const [rejectReason, setRejectReason] = useState('');
  const [reverseReason, setReverseReason] = useState('');
  const reloadHref = `/payments/${encodeURIComponent(paymentId)}`;
  const fields = (
    <>
      <input type="hidden" name="paymentId" value={paymentId} />
      <input type="hidden" name="expectedVersion" value={version} />
    </>
  );
  return (
    <>
      {actions.verify && (
        <TransactionFormDialog<ReviewState>
          trigger="Verify payment"
          title="Verify this payment"
          primary
          description="Confirm the proof matches the money received. Verification issues a receipt and makes the payment available to allocate."
          submit="Verify payment"
          successMessage="Payment verified"
          initial={{ key: keys.verify }}
          action={verifyAction}
          reloadHref={reloadHref}
          focusHeadingOnDone
        >
          {() => fields}
        </TransactionFormDialog>
      )}
      {actions.reject && (
        <TransactionFormDialog<ReviewState>
          trigger="Reject"
          title="Reject this payment"
          destructive
          description="The customer’s invoices will stay open. The reason will be saved with the payment."
          submit="Reject payment"
          successMessage="Payment rejected"
          initial={{ key: keys.reject }}
          action={rejectAction}
          reloadHref={reloadHref}
          focusHeadingOnDone
        >
          {(state) => (
            <>
              {fields}
              <Reason
                label="Reason for rejecting"
                value={rejectReason}
                onChange={setRejectReason}
                error={state.errors?.reason}
              />
            </>
          )}
        </TransactionFormDialog>
      )}
      {actions.reverse && (
        <TransactionFormDialog<ReviewState>
          trigger="Reverse payment"
          title={number ? `Reverse receipt ${number}` : 'Reverse this payment'}
          destructive
          description="Reversing the payment undoes its allocations and reopens the affected invoices. This is permanent."
          submit="Reverse payment"
          successMessage="Payment reversed"
          initial={{ key: keys.reverse }}
          action={reverseAction}
          reloadHref={reloadHref}
          focusHeadingOnDone
        >
          {(state) => (
            <>
              {fields}
              <Reason
                label="Reason for reversing"
                value={reverseReason}
                onChange={setReverseReason}
                error={state.errors?.reason}
              />
            </>
          )}
        </TransactionFormDialog>
      )}
    </>
  );
}

function Reason({
  label,
  value,
  onChange,
  error,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error: string | undefined;
}) {
  return (
    <Field label={label} error={error}>
      {(control) => (
        <Textarea
          {...control}
          name="reason"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          rows={4}
          maxLength={1000}
          required
        />
      )}
    </Field>
  );
}
