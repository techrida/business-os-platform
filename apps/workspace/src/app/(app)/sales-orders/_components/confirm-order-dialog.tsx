'use client';

import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogClose } from '@/components/ui/dialog';
import { EvidenceUpload } from '@/components/ui/evidence-upload';
import { Field, Select } from '@/components/ui/field';
import { TransactionFormDialog } from '@/components/p3/transaction-form-dialog';

import { confirmOrderAction } from '../_lib/actions';
import type { ActionState } from '../_lib/state';
import { CreditHoldHelp } from './credit-hold-help';
import styles from './sales-orders.module.css';

const EVIDENCE_HINT =
  "Optional. The customer purchase order, a contract or the signed quotation. If the company's evidence policy needs them and they are missing, the platform refuses and says so.";

export interface ConfirmOption {
  /** The quotation's `currentVersionId`: the version the order is confirmed from. */
  versionId: string;
  /** The quotation's number, named in the credit override so the person knows which deal it releases. */
  number: string;
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
  const [blocked, setBlocked] = useState(false);
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
      blocked={blocked}
    >
      {(state) => (
        <>
          {state.creditHold ? (
            <CreditHoldHelp
              hold={state.creditHold}
              selectedVersionId={version}
              quotationNumber={
                options.find((o) => o.versionId === state.creditHold?.quotationVersionId)?.number
              }
            />
          ) : null}
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

          {version === '' ? (
            <>
              {/* No file without a quotation: the evidence is uploaded to the version confirmed. */}
              <input type="hidden" name="evidenceDocumentIds" value="" />
              <p className={styles.quiet}>Choose a quotation first, then upload its evidence.</p>
            </>
          ) : (
            // Keyed by the version: choosing another quotation remounts the control, which drops
            // the file staged for the previous one.
            <EvidenceUpload
              key={version}
              kind="quotation-version"
              ownerId={version}
              name="evidenceDocumentIds"
              label="Evidence document (optional)"
              hint={EVIDENCE_HINT}
              error={state.errors?.evidence}
              onBlockingChange={setBlocked}
            />
          )}
        </>
      )}
    </TransactionFormDialog>
  );
}
