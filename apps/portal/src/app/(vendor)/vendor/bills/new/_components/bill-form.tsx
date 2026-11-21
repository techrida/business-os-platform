'use client';

import { CURRENCIES, type Currency } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/portal/alert';
import { Field, Input } from '@/components/portal/field';
import quotation from '@/components/portal/quotation.module.css';
import { Button } from '@/components/ui/button';
import { MoneyInput } from '@/components/ui/number-input';
import { Select } from '@/components/ui/select';
import { currencyOptions } from '@/lib/enabled-currencies';

import { FileUpload } from '../../../_upload/file-upload';
import styles from '../../../_upload/upload.module.css';
import { type BillFormState, submitBillAction } from '../actions';

export interface PoChoice {
  id: string;
  /** The order number and its total, for example `PO-2082-0007 (NPR 12,50,000.50)`, formatted on the server. */
  label: string;
}

/**
 * Submit a bill. A Client Component so the file uploads as it is chosen and the typed values
 * survive a refusal. What it submits goes to a server action. The Idempotency-Key and the
 * uploaded document id live in the form, so a retry after a timeout sends the very same request.
 * The total is the vendor's own figure as typed: this form computes and checks nothing about it.
 */
export function BillForm({
  idempotencyKey,
  today,
  orders,
  initialOrderId,
  currencies,
  initialState,
  numberSystems = DEFAULT_NUMBER_SYSTEMS,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Today in Kathmandu, as `YYYY-MM-DD`: where the invoice date starts, and the latest it can be. */
  today: string;
  orders: readonly PoChoice[];
  initialOrderId: string;
  /** The currencies the company has switched on (`currency.enabled`, D44); the picker offers only these. */
  currencies: readonly Currency[];
  /** Overridable for tests: the state `useActionState` starts from. */
  initialState?: BillFormState | undefined;
  /** How the selling company groups digits, per currency (`PortalDisplay.numberSystems`). */
  numberSystems?: NumberSystems | undefined;
}) {
  const [state, formAction, pending] = useActionState<BillFormState, FormData>(
    submitBillAction,
    initialState ?? { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  // Controlled: React 19 resets uncontrolled fields after every action.
  const [invoiceNo, setInvoiceNo] = useState('');
  // Starts at today in Kathmandu, as the staff bill form does; the vendor can change it.
  const [invoiceDate, setInvoiceDate] = useState(today);
  const [currency, setCurrency] = useState<string>(
    () => currencyOptions(currencies)[0]?.code ?? 'NPR',
  );
  const [total, setTotal] = useState('');
  const [orderId, setOrderId] = useState(initialOrderId);
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const busy = pending || uploading;
  const currencyChoices = currencyOptions(currencies, currency);
  const currencyCode = CURRENCIES.find((c) => c === currency) ?? 'NPR';

  return (
    <form action={formAction} className={`${quotation.form} ${styles.formFrame}`}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {documentId ? <input type="hidden" name="documentId" value={documentId} /> : null}

      {state.error ? (
        <Alert ref={errorRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <FileUpload
        endpoint="/vendor/bills/new/file"
        label="Your bill"
        hint="A PDF or a picture (PNG, JPEG or WebP), up to 25 MB."
        error={fe.file}
        onDocument={setDocumentId}
        onBusy={setUploading}
      />

      <div className={styles.grid}>
        <Field
          label="Your invoice number"
          hint="As printed on your bill."
          error={fe.vendorInvoiceNo}
        >
          {(control) => (
            <Input
              name="vendorInvoiceNo"
              autoComplete="off"
              required
              maxLength={64}
              value={invoiceNo}
              onChange={(e) => setInvoiceNo(e.target.value)}
              {...control}
            />
          )}
        </Field>
        <Field label="Invoice date" error={fe.invoiceDate}>
          {(control) => (
            <Input
              type="date"
              name="invoiceDate"
              required
              max={today}
              value={invoiceDate}
              onChange={(e) => setInvoiceDate(e.target.value)}
              {...control}
            />
          )}
        </Field>
      </div>

      <div className={styles.grid}>
        <Field label="Currency" error={fe.currency}>
          {(control) => (
            <Select
              name="currency"
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              {...control}
            >
              {currencyChoices.map((c) => (
                <option key={c.code} value={c.code} disabled={c.disabled}>
                  {c.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Total on your invoice"
          hint="The amount printed on your bill, for example 20,18,180.00. We check it against our records."
          error={fe.claimedTotal}
        >
          {(control) => (
            <MoneyInput
              {...control}
              name="claimedTotal"
              currency={currencyCode}
              numberSystems={numberSystems}
              required
              showWords
              value={total}
              onValueChange={setTotal}
            />
          )}
        </Field>
      </div>

      <Field
        label="Purchase order (optional)"
        hint={
          orders.length === 0
            ? 'You have no purchase orders to link this bill to.'
            : 'The order this bill is for.'
        }
        error={fe.purchaseOrderId}
      >
        {(control) => (
          <Select
            name="purchaseOrderId"
            value={orderId}
            onChange={(e) => setOrderId(e.target.value)}
            {...control}
          >
            <option value="">Not linked to an order</option>
            {orders.map((o) => (
              <option key={o.id} value={o.id}>
                {o.label}
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div className={quotation.buttons}>
        <Button type="submit" disabled={busy}>
          {pending ? 'Sending…' : 'Submit bill'}
        </Button>
        <Link href="/vendor/bills">Cancel</Link>
      </div>
      <p className={quotation.liveStatus} role="status">
        {pending ? 'Sending your bill' : ''}
      </p>
    </form>
  );
}
