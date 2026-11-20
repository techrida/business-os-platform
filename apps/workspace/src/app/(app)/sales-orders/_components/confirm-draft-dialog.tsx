'use client';

import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';

import { confirmOrderAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';
import { CreditHoldHelp } from './credit-hold-help';

export interface ConfirmDraftDialogProps {
  /** The accepted quotation version the draft was made from. */
  quotationVersionId: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Confirm a draft sales order (F1-Q25): the same `POST /v1/sales-orders` as confirming from the list,
 * which promotes this draft. The draft already carries the quotation's evidence, so nothing is asked here.
 * A credit hold refusal (F1-Q20) offers the same help as confirming from the list: Override for a
 * `credit.override` holder, a link for someone who can open the deal.
 */
export function ConfirmDraftDialog({
  quotationVersionId,
  idempotencyKey,
  reloadHref,
}: ConfirmDraftDialogProps) {
  return (
    <TransactionFormDialog<ActionState>
      trigger="Confirm order"
      primary
      title="Confirm this sales order?"
      description="Confirming gives the order its number and starts its billing schedule: an advance line becomes billable at once."
      submit="Confirm order"
      successMessage="Order confirmed"
      initial={{ key: idempotencyKey }}
      action={confirmOrderAction}
      reloadHref={reloadHref}
    >
      {(state) => (
        <>
          {state.creditHold ? (
            <CreditHoldHelp hold={state.creditHold} selectedVersionId={quotationVersionId} />
          ) : null}
          <input type="hidden" name="quotationVersionId" value={quotationVersionId} />
        </>
      )}
    </TransactionFormDialog>
  );
}
