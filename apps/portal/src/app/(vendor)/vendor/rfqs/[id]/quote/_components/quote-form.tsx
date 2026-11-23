'use client';

import { CURRENCIES, type Currency } from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import Link from 'next/link';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/portal/alert';
import { Field, Input } from '@/components/portal/field';
import quotation from '@/components/portal/quotation.module.css';
import { Button } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { DecimalInput, MoneyInput } from '@/components/ui/number-input';
import { Select } from '@/components/ui/select';
import { currencyOptions } from '@/lib/enabled-currencies';

import { FileUpload } from '../../../../_upload/file-upload';
import styles from '../../../../_upload/upload.module.css';
import { type QuoteFormState, submitQuoteAction } from '../actions';

const PAST_DATE_MESSAGE = 'Enter today or a later date, or leave it empty.';

/**
 * Submit a quotation. A Client Component so the file uploads as it is chosen and the typed values
 * survive a refusal. What it submits goes to a server action. The Idempotency-Key and the
 * uploaded document id live in the form, so a retry after a timeout sends the very same request.
 * The total is the vendor's own figure as typed: this form computes and checks nothing about it.
 */
export function QuoteForm({
  idempotencyKey,
  rfqId,
  today,
  currencies,
  initialState,
  numberSystems = DEFAULT_NUMBER_SYSTEMS,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** The request being quoted, from the page's address. */
  rfqId: string;
  /** Today in Kathmandu, as `YYYY-MM-DD`: the earliest "valid until" date. */
  today: string;
  /** The currencies the company has switched on (D44): the only ones the picker offers. */
  currencies: readonly Currency[];
  /** Overridable for tests: the state `useActionState` starts from. */
  initialState?: QuoteFormState | undefined;
  /** How the selling company groups digits, per currency (`PortalDisplay.numberSystems`). */
  numberSystems?: NumberSystems | undefined;
}) {
  const [state, formAction, pending] = useActionState<QuoteFormState, FormData>(
    (prev, form) => {
      const until = form.get('validUntil');
      if (typeof until === 'string' && until !== '' && until < today) {
        return { key: prev.key, fieldErrors: { validUntil: PAST_DATE_MESSAGE } };
      }
      return submitQuoteAction(prev, form);
    },
    initialState ?? { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  // Controlled: React 19 resets uncontrolled fields after every action.
  // Starts on the first enabled currency (always NPR, the books currency, which is never off).
  const [currency, setCurrency] = useState<string>(
    () => currencyOptions(currencies)[0]?.code ?? 'NPR',
  );
  const [total, setTotal] = useState('');
  const [vendorRef, setVendorRef] = useState('');
  const [validUntil, setValidUntil] = useState('');
  const [deliveryDays, setDeliveryDays] = useState('');
  const [documentId, setDocumentId] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  const busy = pending || uploading;
  const currencyCode = CURRENCIES.find((c) => c === currency) ?? 'NPR';

  return (
    <form noValidate action={formAction} className={`${quotation.form} ${styles.formFrame}`}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="rfqId" value={rfqId} />
      {documentId ? <input type="hidden" name="documentId" value={documentId} /> : null}

      {state.error ? (
        <Alert ref={errorRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      <FileUpload
        endpoint={`/vendor/rfqs/${rfqId}/quote/file`}
        label="Your quotation"
        hint="A PDF or a picture (PNG, JPEG or WebP), up to 25 MB."
        error={fe.file}
        onDocument={setDocumentId}
        onBusy={setUploading}
      />

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
              {currencyOptions(currencies, currency).map((o) => (
                <option key={o.code} value={o.code} disabled={o.disabled}>
                  {o.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field
          label="Total of your quotation"
          hint="We check it against the file."
          error={fe.total}
        >
          {(control) => (
            <MoneyInput
              {...control}
              name="total"
              currency={currencyCode}
              numberSystems={numberSystems}
              required
              showWords
              placeholder="20,18,180.00"
              value={total}
              onValueChange={setTotal}
            />
          )}
        </Field>
      </div>

      <div className={styles.grid}>
        <Field label="Your reference" optional error={fe.vendorRef}>
          {(control) => (
            <Input
              name="vendorRef"
              autoComplete="off"
              maxLength={64}
              placeholder="QT-2083-0412"
              value={vendorRef}
              onChange={(e) => setVendorRef(e.target.value)}
              {...control}
            />
          )}
        </Field>
        <Field label="Prices valid until" optional error={fe.validUntil}>
          {(control) => (
            <DatePicker
              {...control}
              name="validUntil"
              min={today}
              value={validUntil}
              onChange={setValidUntil}
            />
          )}
        </Field>
      </div>

      <Field
        label="Delivery time in days"
        optional
        hint="Counted from our order to delivery."
        error={fe.deliveryDays}
      >
        {(control) => (
          <DecimalInput
            {...control}
            name="deliveryDays"
            intDigits={4}
            scale={0}
            max="1000"
            placeholder="14"
            value={deliveryDays}
            onValueChange={setDeliveryDays}
          />
        )}
      </Field>

      <div className={quotation.buttons}>
        <Button type="submit" disabled={busy}>
          {pending ? 'Sending…' : 'Submit quotation'}
        </Button>
        <Link href={`/vendor/rfqs/${rfqId}`}>Cancel</Link>
      </div>
      <p className={quotation.liveStatus} role="status">
        {pending ? 'Sending your quotation' : ''}
      </p>
    </form>
  );
}
