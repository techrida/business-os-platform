'use client';

import type { Currency } from '@bos/contracts';
import { useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Combobox } from '@/components/ui/combobox';
import { Field, Textarea } from '@/components/ui/field';
import { DecimalInput, MoneyInput, QuantityInput } from '@/components/ui/number-input';

import {
  amendAction,
  cancelAction,
  cancelAndRecreateAction,
  changeVendorAction,
  issueAction,
  shortCloseAction,
} from '../actions';
import { qtyText } from '../_lib/model';
import { storedNumberText } from '@bos/locale';
import styles from '../orders.module.css';

import { ProcurementActionDialog } from '../../action-dialog';

interface Common {
  purchaseOrderId: string;
  number: string;
  idempotencyKey: string;
  reloadHref: string;
}

/** `version` is the order's row version as the page showed it: issue is refused if the order changed since. */
export function IssueDialog(props: Common & { version: number }) {
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
      fields={() => <input type="hidden" name="expectedVersion" value={props.version} />}
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

/**
 * Cancels an issued order and opens the new draft raised from it (the action redirects there), where the vendor
 * can be changed before it is issued again.
 */
export function RecreateDialog(common: Common) {
  return (
    <ProcurementActionDialog
      triggerLabel="Cancel and recreate"
      title={`Cancel and recreate ${common.number}`}
      intro="This order is cancelled and a new draft with the same lines and prices opens. Change its vendor there, then issue it. It works only before anything is received on this order."
      action={cancelAndRecreateAction}
      idempotencyKey={common.idempotencyKey}
      recordField="purchaseOrderId"
      recordId={common.purchaseOrderId}
      reloadHref={common.reloadHref}
      reloadLabel="Reload this purchase order"
      submitLabel="Cancel and recreate"
      pendingWords="Cancelling the order and creating the new draft"
      submitVariant="secondary"
      fields={(errors) => <ReasonField errors={errors} />}
    />
  );
}

export interface VendorChoice {
  id: string;
  name: string;
}

function VendorField({
  vendors,
  problem,
  errors,
}: {
  vendors: readonly VendorChoice[];
  problem: string | undefined;
  errors: Record<string, string>;
}) {
  // Controlled, so a refusal does not wipe the vendor the person chose.
  const [vendorId, setVendorId] = useState('');
  const [open, setOpen] = useState(false);
  return (
    <>
      {problem !== undefined ? (
        <Alert tone="error" role="alert" title="Vendors did not load">
          {problem}
        </Alert>
      ) : null}
      {errors['acknowledgeVatWarning'] !== undefined &&
      errors['acknowledgeVatWarningVendor'] === vendorId ? (
        <VatAcknowledge message={errors['acknowledgeVatWarning']} />
      ) : null}
      <Field
        label="New vendor"
        hint="Only approved vendors are listed. The vendor also needs an active account with your legal entity and a verified bank account."
        error={errors['vendorId']}
      >
        {(control) => (
          <>
            <input type="hidden" name="vendorId" value={vendorId} />
            <Combobox
              labelledBy={control['aria-labelledby']}
              describedBy={control['aria-describedby']}
              invalid={control['aria-invalid'] === true}
              options={vendors.map((v) => ({ id: v.id, label: v.name }))}
              value={vendorId}
              onChange={setVendorId}
              open={open}
              onOpenChange={setOpen}
              placeholder="Search by vendor name"
              emptyText="No other approved vendor to choose from."
              noMatchText="No vendor matches. Search by name."
              required
            />
          </>
        )}
      </Field>
    </>
  );
}

/** The soft VAT warning of a vendor change (K3 Q2): shown after the API asks, and the person ticks to go on. */
function VatAcknowledge({ message }: { message: string }) {
  const [ticked, setTicked] = useState(false);
  return (
    <>
      <Alert tone="warning" role="alert" title="The vendor is not VAT registered">
        {message}
      </Alert>
      <label>
        <input
          type="checkbox"
          name="acknowledgeVatWarning"
          checked={ticked}
          onChange={(e) => setTicked(e.target.checked)}
        />{' '}
        I understand, change the vendor anyway
      </label>
    </>
  );
}

/** Moves a draft to another approved vendor (F1-Q40 a). */
export function ChangeVendorDialog({
  vendors,
  problem,
  ...common
}: Common & { vendors: readonly VendorChoice[]; problem?: string | undefined }) {
  return (
    <ProcurementActionDialog
      triggerLabel="Change vendor"
      title={`Change the vendor of ${common.number}`}
      intro="The new vendor must have quoted on this order's RFQ. The lines, prices and total become its quotation's, and payment terms come from the new vendor. A different total goes back for approval first."
      action={changeVendorAction}
      idempotencyKey={common.idempotencyKey}
      recordField="purchaseOrderId"
      recordId={common.purchaseOrderId}
      reloadHref={common.reloadHref}
      reloadLabel="Reload this purchase order"
      submitLabel="Change vendor"
      pendingWords="Changing the vendor"
      fields={(errors) => <VendorField vendors={vendors} problem={problem} errors={errors} />}
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
      lines.map((l) => [
        l.id,
        { quantity: qtyText(l.orderedQuantity), unitPrice: storedNumberText(l.unitPrice, 2) },
      ]),
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
                <QuantityInput
                  name={`qty:${l.id}`}
                  value={values[l.id]?.quantity ?? ''}
                  onValueChange={(plain) => set(l.id, 'quantity', plain)}
                  uom={l.uom}
                  currency={currency as Currency}
                  {...control}
                />
              )}
            </Field>
            <Field label="Unit price" error={errors[`${l.id}.unitPrice`]}>
              {(control) => (
                <MoneyInput
                  name={`price:${l.id}`}
                  value={values[l.id]?.unitPrice ?? ''}
                  onValueChange={(plain) => set(l.id, 'unitPrice', plain)}
                  currency={currency as Currency}
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
          <DecimalInput
            name="paymentTerms"
            value={terms}
            onValueChange={setTerms}
            intDigits={3}
            scale={0}
            min="0"
            max="365"
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
