'use client';

import { CURRENCIES, type Currency, PAYMENT_METHODS, type PaymentMethod } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import { methodLabel } from '../_lib/status';

import { recordPaymentAction } from './actions';
import type { RecordPaymentState } from './form-state';
import styles from './payment-form.module.css';
import { MAX_PROOFS, PROOF_ACCEPT, proofProblem } from './proof-rules';

/** One customer the person can choose. Names and numbers only: the form shows no balances. */
export interface CustomerOption {
  id: string;
  name: string;
  number: string;
  /** The customer's usual currency, used as the starting choice. */
  defaultCurrency: Currency | null;
}

interface Proof {
  documentId: string;
  filename: string;
}

/**
 * Record a payment on a customer's behalf, with proof. A Client Component so the proof files
 * upload as they are chosen (to the workspace's own upload route, never to the API directly: the
 * browser has no token or API address) and the typed values survive a refusal. What it submits
 * goes to a server action. The Idempotency-Key and the uploaded proof ids live in the form, so a
 * retry after a timeout sends the very same request. This form computes nothing: amounts are text
 * the server checks and the receipt, settled value and left-to-allocate figures come back from it.
 *
 * A proof is stored against the customer it was uploaded for, so the customer is locked while the
 * form holds proof, and the file picker waits for a customer.
 */
export function PaymentForm({
  idempotencyKey,
  today,
  customers,
  initialCustomerId,
  reloadHref,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Today in Kathmandu, as `YYYY-MM-DD`: the latest date a payment can have been received. */
  today: string;
  customers: readonly CustomerOption[];
  initialCustomerId: string;
  reloadHref: string;
}) {
  const [state, formAction, pending] = useActionState<RecordPaymentState, FormData>(
    recordPaymentAction,
    { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  // Controlled: React 19 resets uncontrolled fields after every action.
  const [customerId, setCustomerId] = useState(initialCustomerId);
  const [currency, setCurrency] = useState<string>(
    customers.find((c) => c.id === initialCustomerId)?.defaultCurrency ?? 'NPR',
  );
  const [currencyChosen, setCurrencyChosen] = useState(false);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [receivedOn, setReceivedOn] = useState(today);
  const [bankReference, setBankReference] = useState('');
  const [tds, setTds] = useState('');
  const [code, setCode] = useState('');

  const [proofs, setProofs] = useState<Proof[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  function chooseCustomer(id: string) {
    setCustomerId(id);
    const fallback = customers.find((c) => c.id === id)?.defaultCurrency;
    if (!currencyChosen && fallback) setCurrency(fallback);
  }

  async function addFiles(files: FileList | null) {
    if (files === null || customerId === '') return;
    const picked = [...files];
    const room = MAX_PROOFS - proofs.length;
    const found: string[] = [];
    const accepted = picked.slice(0, Math.max(room, 0));
    if (picked.length > accepted.length) found.push(`You can add up to ${MAX_PROOFS} files.`);
    setProblems([]);
    for (const file of accepted) {
      const problem = proofProblem(file);
      if (problem !== null) {
        found.push(problem);
        continue;
      }
      setUploading((n) => n + 1);
      try {
        const res = await fetch('/payments/proofs', {
          method: 'POST',
          headers: {
            'content-type': file.type,
            'x-file-name': encodeURIComponent(file.name),
            'x-customer-id': customerId,
          },
          body: file,
        });
        const body = (await res.json().catch(() => null)) as {
          documentId?: string;
          error?: { message?: string };
        } | null;
        if (res.ok && typeof body?.documentId === 'string') {
          const documentId = body.documentId;
          setProofs((list) => [...list, { documentId, filename: file.name }]);
        } else {
          found.push(`${file.name}: ${body?.error?.message ?? 'the upload failed. Try again.'}`);
        }
      } catch {
        found.push(`${file.name}: the upload failed. Check the connection and try again.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    setProblems(found);
    // Allow choosing the same file again after removing it.
    if (pickerRef.current) pickerRef.current.value = '';
  }

  const busy = pending || uploading > 0;
  const customerLocked = proofs.length > 0 || uploading > 0;

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {/* The select below is locked while proof is held, and a locked select sends nothing. */}
      <input type="hidden" name="customerId" value={customerId} />
      {proofs.map((p) => (
        <input key={p.documentId} type="hidden" name="proofDocumentId" value={p.documentId} />
      ))}

      {state.error ? (
        <Alert
          ref={errorRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title={state.reload ? 'This page is out of date' : 'The payment was not recorded'}
          actions={state.reload ? <a href={reloadHref}>Reload the form</a> : null}
        >
          {state.error}
        </Alert>
      ) : null}

      <Panel
        title="Payment details"
        description="What the customer paid, as it appears on the bank slip."
      >
        <div className={styles.form}>
          <Field
            label="Customer"
            hint={
              customerLocked
                ? 'Remove the proof files below to change the customer.'
                : 'Proof is stored against this customer.'
            }
            error={fe.customerId}
          >
            {(control) => (
              <Select
                value={customerId}
                disabled={customerLocked}
                onChange={(e) => chooseCustomer(e.target.value)}
                required
                {...control}
              >
                <option value="">Choose a customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.number})
                  </option>
                ))}
              </Select>
            )}
          </Field>

          <div className={styles.grid}>
            <Field label="Currency" error={fe.currency}>
              {(control) => (
                <Select
                  name="currency"
                  required
                  value={currency}
                  onChange={(e) => {
                    setCurrency(e.target.value);
                    setCurrencyChosen(true);
                  }}
                  {...control}
                >
                  {CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Amount received"
              hint="The cash that arrived, for example 20,18,180.00."
              error={fe.amount}
            >
              {(control) => (
                <Input
                  name="amount"
                  inputMode="decimal"
                  autoComplete="off"
                  required
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  className={styles.numeric}
                  {...control}
                />
              )}
            </Field>
          </div>

          <div className={styles.grid}>
            <Field label="Payment method" error={fe.method}>
              {(control) => (
                <Select
                  name="method"
                  required
                  value={method}
                  onChange={(e) => setMethod(e.target.value as PaymentMethod)}
                  {...control}
                >
                  {PAYMENT_METHODS.map((m) => (
                    <option key={m} value={m}>
                      {methodLabel(m)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label="Received on" error={fe.receivedOn}>
              {(control) => (
                <Input
                  type="date"
                  name="receivedOn"
                  required
                  max={today}
                  value={receivedOn}
                  onChange={(e) => setReceivedOn(e.target.value)}
                  {...control}
                />
              )}
            </Field>
          </div>

          <Field
            label="Bank reference"
            hint="Optional. The transaction or cheque number on the slip, so Finance can match it."
            error={fe.bankReference}
          >
            {(control) => (
              <Input
                name="bankReference"
                autoComplete="off"
                maxLength={100}
                value={bankReference}
                onChange={(e) => setBankReference(e.target.value)}
                {...control}
              />
            )}
          </Field>

          <details className={styles.tds} open={Boolean(fe.tdsWithheld || fe.withholdingCode)}>
            <summary>The customer withheld tax at source (TDS)</summary>
            <div className={styles.grid}>
              <Field
                label="Tax withheld"
                hint="The amount withheld and not sent. Leave empty if none."
                error={fe.tdsWithheld}
              >
                {(control) => (
                  <Input
                    name="tdsWithheld"
                    inputMode="decimal"
                    autoComplete="off"
                    placeholder="0.00"
                    value={tds}
                    onChange={(e) => setTds(e.target.value)}
                    className={styles.numeric}
                    {...control}
                  />
                )}
              </Field>
              <Field
                label="Withholding code"
                hint="Required when tax was withheld."
                error={fe.withholdingCode}
              >
                {(control) => (
                  <Input
                    name="withholdingCode"
                    autoComplete="off"
                    maxLength={40}
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    {...control}
                  />
                )}
              </Field>
            </div>
            <p className={styles.note}>
              Type the code exactly as it appears on the tax certificate. The platform works out
              what the payment settles.
            </p>
          </details>
        </div>
      </Panel>

      <Panel
        title="Proof of payment"
        description={`A bank slip or receipt, as a PDF or a picture, up to ${MAX_PROOFS} files. Each file is checked for viruses before the payment can use it.`}
      >
        <Field
          label="Add proof files"
          hint={
            customerId === '' ? 'Choose the customer first.' : 'You can add several files at once.'
          }
          error={fe.proof}
        >
          {(control) => (
            <Input
              ref={pickerRef}
              type="file"
              multiple
              accept={PROOF_ACCEPT}
              disabled={customerId === '' || proofs.length >= MAX_PROOFS}
              onChange={(e) => void addFiles(e.target.files)}
              {...control}
            />
          )}
        </Field>
        <p className={styles.status} role="status">
          {uploading > 0 ? `Uploading ${uploading} ${uploading === 1 ? 'file' : 'files'}…` : ''}
        </p>
        {problems.length > 0 ? (
          <ul className={styles.problems} role="alert">
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
        ) : null}
        {proofs.length > 0 ? (
          <ul className={styles.proofs} aria-label="Uploaded proof">
            {proofs.map((p) => (
              <li key={p.documentId}>
                <span>{p.filename}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="small"
                  aria-label={`Remove ${p.filename}`}
                  onClick={() => setProofs((l) => l.filter((x) => x.documentId !== p.documentId))}
                >
                  Remove
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </Panel>

      <div className={styles.actions}>
        <Button type="submit" disabled={busy}>
          {pending ? 'Recording' : 'Record payment'}
        </Button>
        <LinkButton href="/payments" variant="ghost">
          Cancel
        </LinkButton>
      </div>
      <p className={styles.status} role="status">
        {pending ? 'Recording the payment' : ''}
      </p>
    </form>
  );
}
