'use client';

import {
  CURRENCIES,
  type Currency,
  MONEY_LIMITS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '@bos/contracts';
import { DEFAULT_NUMBER_SYSTEMS, type NumberSystems } from '@bos/locale';
import { type ComponentProps, useActionState, useEffect, useRef, useState } from 'react';

import { type PaymentFormState, submitPaymentAction } from '@/app/(portal)/payments/actions';
import { Alert } from '@/components/portal/alert';
import { Field, Input } from '@/components/portal/field';
import quotation from '@/components/portal/quotation.module.css';
import { Button } from '@/components/ui/button';
import { DecimalInput, MoneyInput } from '@/components/ui/number-input';
import { Select } from '@/components/ui/select';

import styles from './payment-form.module.css';
import { METHOD_LABEL } from './payment-status';
import { MAX_PROOFS, PROOF_ACCEPT, proofProblem } from './proof-rules';

interface Proof {
  documentId: string;
  filename: string;
}

/**
 * Submit a payment with proof. A Client Component so the proof files upload as they are chosen (to
 * the portal's own upload route, never to the API directly: the browser has no token or API
 * address) and the typed values survive a refusal. What it submits goes to a server action. The
 * Idempotency-Key and the uploaded proof ids live in the form, so a retry after a timeout sends the
 * very same request. When the customer arrives from an invoice, the currency and the amount still
 * open are the server's figures, passed in as strings; this form computes nothing.
 *
 * Every currency is offered and choosable: a payment is money already sent, so it is accepted in a
 * currency the company has switched off (D56 U16-Q1), and such a currency says so. From an invoice
 * in a switched-off currency the form starts with no currency chosen (no silent move to NPR) and
 * with the invoice's open amount filled in; the Currency field names the invoice's currency.
 */
/** Every currency in the fixed order; `off` marks one the company has switched off (NPR never is). */
export function paymentCurrencyOptions(
  enabled: readonly Currency[],
): { code: Currency; off: boolean }[] {
  return CURRENCIES.map((code) => ({ code, off: code !== 'NPR' && !enabled.includes(code) }));
}

/**
 * An amount in the chosen currency. With no currency chosen yet (an invoice in a switched-off
 * currency starts blank) there is no code to show and no grouping to follow, so the box still
 * limits digits and decimals but shows no currency.
 */
function AmountBox({
  currency,
  numberSystems,
  showWords,
  ...rest
}: Omit<ComponentProps<typeof MoneyInput>, 'currency'> & {
  currency: Currency | undefined;
}) {
  if (currency === undefined) {
    return <DecimalInput {...rest} intDigits={MONEY_LIMITS.intDigits} scale={MONEY_LIMITS.scale} />;
  }
  return (
    <MoneyInput {...rest} currency={currency} numberSystems={numberSystems} showWords={showWords} />
  );
}

export function PaymentForm({
  idempotencyKey,
  today,
  invoice,
  defaultCurrency,
  enabledCurrencies,
  suggestedAmount,
  numberSystems = DEFAULT_NUMBER_SYSTEMS,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Today in Kathmandu, as `YYYY-MM-DD`: the latest date a payment can have been received. */
  today: string;
  /** The invoice the customer came from, when there is one. Context only: the payment is allocated by our finance team. */
  invoice?: { id: string; number: string } | undefined;
  /** The invoice's currency, else NPR. */
  defaultCurrency: Currency;
  /** The company's enabled currencies (`portalEnabledCurrencies`). */
  enabledCurrencies: readonly Currency[];
  /** The server's open amount for that invoice, or empty. */
  suggestedAmount: string;
  /** How the selling company groups digits, per currency (`PortalDisplay.numberSystems`). */
  numberSystems?: NumberSystems | undefined;
}) {
  const [state, formAction, pending] = useActionState<PaymentFormState, FormData>(
    submitPaymentAction,
    { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};

  const options = paymentCurrencyOptions(enabledCurrencies);
  const isOff = (code: string) => options.some((o) => o.code === code && o.off);
  const invoiceCurrencyOff = isOff(defaultCurrency);

  // Controlled: React 19 resets uncontrolled fields after every action. Set on the first render,
  // because the hidden field submits whatever value it holds.
  const [currency, setCurrency] = useState<string>(invoiceCurrencyOff ? '' : defaultCurrency);
  const [amount, setAmount] = useState(suggestedAmount);
  const chosenCurrency = CURRENCIES.find((c) => c === currency);
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [receivedOn, setReceivedOn] = useState(today);
  const [bankReference, setBankReference] = useState('');
  const [tds, setTds] = useState('');
  const [code, setCode] = useState('');

  const [proofs, setProofs] = useState<Proof[]>([]);
  const [problems, setProblems] = useState<string[]>([]);
  const [uploading, setUploading] = useState(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error) errorRef.current?.focus();
  }, [state]);

  async function addFiles(files: FileList | null) {
    if (files === null) return;
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
          headers: { 'content-type': file.type, 'x-file-name': encodeURIComponent(file.name) },
          body: file,
        });
        const body = (await res.json().catch(() => null)) as {
          documentId?: string;
          error?: string;
        } | null;
        if (res.ok && typeof body?.documentId === 'string') {
          const documentId = body.documentId;
          setProofs((list) => [...list, { documentId, filename: file.name }]);
        } else {
          found.push(`${file.name}: ${body?.error ?? 'the upload failed. Try again.'}`);
        }
      } catch {
        found.push(`${file.name}: the upload failed. Check your connection and try again.`);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    setProblems(found);
    // Allow choosing the same file again after removing it.
    if (pickerRef.current) pickerRef.current.value = '';
  }

  const busy = pending || uploading > 0;

  return (
    <form noValidate action={formAction} className={quotation.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      {invoice ? <input type="hidden" name="invoice" value={invoice.id} /> : null}
      {proofs.map((p) => (
        <input key={p.documentId} type="hidden" name="proofDocumentId" value={p.documentId} />
      ))}

      {state.error ? (
        <Alert ref={errorRef} tabIndex={-1} tone="error" role="alert">
          {state.error}
        </Alert>
      ) : null}

      {invoice ? (
        <p className={styles.context}>
          <span>
            Paying invoice <strong>{invoice.number}</strong>
          </span>
          <span className={quotation.muted}>
            Our finance team matches your payment to the invoice once they have checked your proof.
          </span>
        </p>
      ) : null}

      <div className={styles.grid}>
        <Field
          label="Currency"
          hint={
            invoiceCurrencyOff
              ? `This invoice is in ${defaultCurrency}, which is switched off for the company. Payments in it are still accepted.${suggestedAmount === '' ? '' : ` The amount filled in is in ${defaultCurrency}.`}`
              : isOff(currency)
                ? `${currency} is switched off for the company. Payments in it are still accepted.`
                : undefined
          }
          error={fe.currency}
        >
          {(control) => (
            <Select
              name="currency"
              required
              value={currency}
              onChange={(e) => setCurrency(e.target.value)}
              {...control}
            >
              <option value="">Choose a currency</option>
              {options.map((o) => (
                <option key={o.code} value={o.code}>
                  {o.off ? `${o.code}, switched off` : o.code}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Amount paid" error={fe.amount}>
          {(control) => (
            <AmountBox
              {...control}
              name="amount"
              currency={chosenCurrency}
              numberSystems={numberSystems}
              required
              min="0.01"
              showWords
              placeholder="20,18,180.00"
              value={amount}
              onValueChange={setAmount}
            />
          )}
        </Field>
      </div>

      <div className={styles.grid}>
        <Field label="How you paid" error={fe.method}>
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
                  {METHOD_LABEL[m]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Date you paid" error={fe.receivedOn}>
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

      <Field label="Bank reference" optional error={fe.bankReference}>
        {(control) => (
          <Input
            name="bankReference"
            autoComplete="off"
            maxLength={100}
            placeholder="TXN-48213"
            value={bankReference}
            onChange={(e) => setBankReference(e.target.value)}
            {...control}
          />
        )}
      </Field>

      <details className={styles.tds} open={Boolean(fe.tdsWithheld || fe.withholdingCode)}>
        <summary>You withheld tax at source (TDS)</summary>
        <div className={styles.grid}>
          <Field
            label="Tax withheld"
            hint="The amount you withheld and did not send."
            error={fe.tdsWithheld}
          >
            {(control) => (
              <AmountBox
                {...control}
                name="tdsWithheld"
                currency={chosenCurrency}
                numberSystems={numberSystems}
                placeholder="0.00"
                value={tds}
                onValueChange={setTds}
              />
            )}
          </Field>
          <Field label="Withholding code" error={fe.withholdingCode}>
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
      </details>

      <div>
        <Field
          label="Proof of payment"
          hint={`A bank slip or receipt, as a PDF or a picture, up to ${MAX_PROOFS} files.`}
          error={fe.proof}
        >
          {(control) => (
            <Input
              ref={pickerRef}
              type="file"
              multiple
              accept={PROOF_ACCEPT}
              disabled={proofs.length >= MAX_PROOFS}
              onChange={(e) => void addFiles(e.target.files)}
              {...control}
            />
          )}
        </Field>
        <p className={quotation.liveStatus} role="status">
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
      </div>

      <div className={quotation.buttons}>
        <Button type="submit" disabled={busy}>
          {pending ? 'Submitting…' : 'Submit payment'}
        </Button>
        <a href={invoice ? `/invoices/${invoice.id}` : '/payments'}>Cancel</a>
      </div>
      <p className={quotation.liveStatus} role="status">
        {pending ? 'Sending your payment' : ''}
      </p>
    </form>
  );
}
