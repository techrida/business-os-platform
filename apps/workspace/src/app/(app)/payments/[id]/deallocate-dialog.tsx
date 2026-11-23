'use client';

import { useState } from 'react';

import { Field, Textarea } from '@/components/ui/field';

import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';
import { deallocateAction, type AllocateState } from './allocate-actions';

export function DeallocateDialog({
  paymentId,
  allocationId,
  label,
  idempotencyKey,
  reloadHref,
}: {
  paymentId: string;
  allocationId: string;
  label: string;
  idempotencyKey: string;
  reloadHref: string;
}) {
  const [reason, setReason] = useState('');
  return (
    <TransactionFormDialog<AllocateState>
      trigger={`Deallocate ${label}`}
      title={`Deallocate ${label}`}
      destructive
      description="The invoice balance will increase and the credit will return to this payment. The reversal and its reason will appear in the allocation history."
      submit="Deallocate"
      successMessage="Allocation reversed"
      initial={{ key: idempotencyKey }}
      action={deallocateAction}
      reloadHref={reloadHref}
      focusHeadingOnDone
    >
      {(state) => (
        <>
          <input type="hidden" name="paymentId" value={paymentId} />
          <input type="hidden" name="allocationId" value={allocationId} />
          <Field label="Reason for deallocating" error={state.errors?.reason}>
            {(control) => (
              <Textarea
                {...control}
                name="reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={4}
                maxLength={1000}
                required
              />
            )}
          </Field>
        </>
      )}
    </TransactionFormDialog>
  );
}
