'use client';

import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { Field, Select, Textarea } from '@/components/ui/field';
import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';

import { confirmOrderAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';
import { CreditHoldHelp } from './credit-hold-help';

export interface ConfirmOption {
  /** The quotation's `currentVersionId`: the version the order is confirmed from. */
  versionId: string;
  /** Number, customer and total, already worded by the server. */
  label: string;
}

export interface ConfirmOrderDialogProps {
  /** The accepted quotations, or null when they could not be read. */
  options: readonly ConfirmOption[] | null;
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  reloadHref: string;
}

export function ConfirmOrderDialog({
  options,
  idempotencyKey,
  reloadHref,
}: ConfirmOrderDialogProps) {
  const [version, setVersion] = useState('');
  const [evidence, setEvidence] = useState('');
  if (!options?.length) {
    return (
      <Dialog
        size="small"
        title="Confirm a sales order"
        trigger={<Button>Confirm from quotation</Button>}
        footer={
          <DialogClose asChild>
            <Button variant="secondary">Close</Button>
          </DialogClose>
        }
      >
        {options === null ? (
          <Alert
            tone="error"
            role="alert"
            title="The accepted quotations did not load"
            actions={<a href={reloadHref}>Reload the sales orders</a>}
          >
            Reload the page to try again.
          </Alert>
        ) : (
          <p>
            No accepted quotations are waiting. A quotation is available once the customer accepts
            it.
          </p>
        )}
      </Dialog>
    );
  }
  return (
    <TransactionFormDialog<ActionState>
      trigger="Confirm from quotation"
      primary
      title="Confirm a sales order"
      description="Confirm the accepted quotation to create the order and its billing schedule."
      submit="Confirm order"
      successMessage="Order confirmed"
      initial={{ key: idempotencyKey }}
      action={confirmOrderAction}
      reloadHref={reloadHref}
      size="large"
    >
      {(state) => (
        <>
          {state.creditHold ? <CreditHoldHelp hold={state.creditHold} /> : null}
          <Field label="Accepted quotation" error={state.errors?.quotation}>
            {(control) => (
              <Select
                name="quotationVersionId"
                value={version}
                onChange={(e) => setVersion(e.target.value)}
                {...control}
              >
                <option value="">Choose a quotation</option>
                {options.map((option) => (
                  <option key={option.versionId} value={option.versionId}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <Field
            label="Evidence documents (optional)"
            hint="Document ids, one per line: the customer purchase order, a contract or the signed quotation. If the company's evidence policy needs them and they are missing, the platform refuses and says so."
            error={state.errors?.evidence}
          >
            {(control) => (
              <Textarea
                name="evidenceDocumentIds"
                value={evidence}
                onChange={(e) => setEvidence(e.target.value)}
                rows={3}
                spellCheck={false}
                autoComplete="off"
                {...control}
              />
            )}
          </Field>
        </>
      )}
    </TransactionFormDialog>
  );
}
