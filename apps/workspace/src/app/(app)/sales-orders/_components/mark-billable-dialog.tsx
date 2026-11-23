'use client';

import { useState } from 'react';
import { EvidenceUpload } from '@/components/ui/evidence-upload';
import { Field, Select } from '@/components/ui/field';
import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';
import { markBillableAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';

export interface EvidenceOption {
  documentId: string;
  /** Kind and the end of the id, already worded by the server. */
  label: string;
}

export interface MarkBillableDialogProps {
  salesOrderId: string;
  scheduleLineId: string;
  /** The step's name, for the title. */
  lineLabel: string;
  /** The order's `version`: schedule lines carry none of their own. */
  version: number;
  /** The order's evidence: the preferred source of the document. */
  evidence: readonly EvidenceOption[];
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

export function MarkBillableDialog({
  salesOrderId,
  scheduleLineId,
  version,
  lineLabel,
  evidence,
  idempotencyKey,
  reloadHref,
}: MarkBillableDialogProps) {
  const [chosen, setChosen] = useState('');
  const [blocked, setBlocked] = useState(false);
  const listed = evidence.length > 0;
  return (
    <TransactionFormDialog<ActionState>
      trigger="Mark billable"
      title={`Mark "${lineLabel}" billable`}
      description="Attach evidence that the milestone or acceptance step is complete. An invoice can then be drafted."
      submit="Mark billable"
      successMessage="Step marked billable"
      initial={{ key: idempotencyKey }}
      action={markBillableAction}
      reloadHref={reloadHref}
      focusHeadingOnDone
      blocked={blocked}
    >
      {(state) => (
        <>
          <input type="hidden" name="salesOrderId" value={salesOrderId} />
          <input type="hidden" name="scheduleLineId" value={scheduleLineId} />
          <input type="hidden" name="expectedVersion" value={version} />
          {listed ? <input type="hidden" name="evidenceListed" value="1" /> : null}
          {listed ? (
            <Field
              label="Evidence document"
              hint="Choose from the evidence already attached to this order. This is the preferred way."
              error={state.errors?.document}
            >
              {(control) => (
                <Select
                  name="evidenceDocumentId"
                  value={chosen}
                  onChange={(e) => setChosen(e.target.value)}
                  {...control}
                >
                  <option value="">Choose a document</option>
                  {evidence.map((item) => (
                    <option key={item.documentId} value={item.documentId}>
                      {item.label}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          ) : null}

          <EvidenceUpload
            kind="sales-order"
            ownerId={salesOrderId}
            name="otherDocumentId"
            label={listed ? 'Or upload another document' : 'Evidence document'}
            hint={
              listed
                ? 'Only if the document you need is not in the list. An upload is used instead of the list.'
                : 'Upload the document that shows this step was done, such as the signed acceptance.'
            }
            error={listed ? undefined : state.errors?.document}
            onBlockingChange={setBlocked}
          />
        </>
      )}
    </TransactionFormDialog>
  );
}
