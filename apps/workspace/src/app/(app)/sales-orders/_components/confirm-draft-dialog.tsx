'use client';

import { useState } from 'react';

import { EvidenceUpload } from '@/components/ui/evidence-upload';
import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';

import { confirmOrderAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';
import { CreditHoldHelp } from './credit-hold-help';

const EVIDENCE_HINT =
  "Optional. A file you hold for this order, such as the customer purchase order. It is kept with the order. What the company's evidence policy needs comes from the customer's accepted evidence.";

export interface ConfirmDraftDialogProps {
  /** The accepted quotation version the draft was made from. */
  quotationVersionId: string;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

/**
 * Confirm a draft sales order (F1-Q25): the same `POST /v1/sales-orders` as confirming from the list,
 * which promotes this draft. The draft already carries the quotation's evidence; the person may add a
 * file they hold (such as the customer purchase order), uploaded to the draft's quotation version and
 * filed with the order on confirm, the same shared control as confirming from the list. Confirm waits
 * while the file uploads, and removing the file or closing the dialog keeps nothing.
 * A credit hold refusal (F1-Q20) offers the same help as confirming from the list: Override for a
 * `credit.override` holder, a link for someone who can open the deal.
 */
export function ConfirmDraftDialog({
  quotationVersionId,
  idempotencyKey,
  reloadHref,
}: ConfirmDraftDialogProps) {
  const [blocked, setBlocked] = useState(false);
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
      blocked={blocked}
    >
      {(state) => (
        <>
          {state.creditHold ? (
            <CreditHoldHelp hold={state.creditHold} selectedVersionId={quotationVersionId} />
          ) : null}
          <input type="hidden" name="quotationVersionId" value={quotationVersionId} />
          {/* The draft fixes the version, so the control never remounts for another one. */}
          <EvidenceUpload
            kind="quotation-version"
            ownerId={quotationVersionId}
            name="evidenceDocumentIds"
            label="Evidence document (optional)"
            hint={EVIDENCE_HINT}
            error={state.errors?.evidence}
            onBlockingChange={setBlocked}
          />
        </>
      )}
    </TransactionFormDialog>
  );
}
