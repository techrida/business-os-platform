'use client';

import { CURRENCIES, type Currency, PAYMENT_METHODS, type PaymentMethod } from '@bos/contracts';
import { type ReactNode, useActionState, useEffect, useId, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select } from '@/components/ui/field';
import { DatePicker } from '@/components/ui/date-picker';
import { Icon } from '@/components/ui/icon';
import { PageHeader } from '@/components/ui/page';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { toast } from '@/components/ui/toast';
import { Panel } from '@/components/ui/panel';
import { CURRENCY_NAME, normalizeEnabled } from '@/lib/enabled-currencies';
import { money, when } from '@/lib/kernel-format';

import { methodLabel, paymentStatusMeta } from '../_lib/status';

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

/**
 * Where a form opened from an invoice starts (U16-Q8 a): the page read the invoice from the API, so the amount is the
 * open amount the server reports, never a figure from the link. It is only a starting value: the amount stays
 * editable for a part payment, and choosing another customer drops it while untouched.
 */
export interface PaymentPrefill {
  /** The invoice's customer, the one the picker starts on. */
  customerId: string;
  currency: Currency;
  /** The invoice's open amount as the API sent it (a decimal string). */
  amount: string;
  invoiceNumber: string | null;
}

/**
 * The customer a form opened from an invoice pays (item 3b), resolved on the server from that invoice. Shown read-only
 * by name: the form reads no customer list, so a role without customer.read can record the payment. The action reads
 * the invoice again and pays its customer, whatever the posted customer field says.
 */
export interface FixedCustomer {
  id: string;
  name: string;
  invoiceId: string;
}

/**
 * The currency the form starts on for a customer: their usual one while it is enabled in Settings,
 * else blank when that usual one is switched off (the person chooses; no silent move to NPR), else
 * NPR for a customer with no usual currency.
 */
export function startCurrency(
  defaultCurrency: Currency | null | undefined,
  enabled: readonly Currency[],
): Currency | '' {
  if (!defaultCurrency) return 'NPR';
  return enabled.includes(defaultCurrency) ? defaultCurrency : '';
}

/**
 * Every currency, each choosable: a payment is money that has already arrived, so it is accepted in
 * a currency switched off in Settings (D56 U16-Q1). A switched-off one says so in its label.
 */
export function paymentCurrencyChoices(
  enabled: readonly Currency[],
): { value: Currency; label: string; on: boolean }[] {
  const on = new Set<Currency>(normalizeEnabled(enabled));
  return CURRENCIES.map((c) => ({
    value: c,
    label: on.has(c) ? CURRENCY_NAME[c] : `${CURRENCY_NAME[c]}, switched off`,
    on: on.has(c),
  }));
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
/** Card heading with its Figma eyebrow ("01 · The basics"). The eyebrow is decoration. */
function SectionTitle({ eyebrow, children }: { eyebrow: string; children: ReactNode }) {
  return (
    <>
      <span className={styles.eyebrow} aria-hidden="true">
        {eyebrow}
      </span>
      {children}
    </>
  );
}

export function PaymentForm({
  idempotencyKey,
  today,
  customers,
  enabledCurrencies,
  initialCustomerId,
  prefill = null,
  fixedCustomer = null,
  reloadHref,
  children,
}: {
  /** A UUID the server generated for this render. */
  idempotencyKey: string;
  /** Today in Kathmandu, as `YYYY-MM-DD`: the latest date a payment can have been received. */
  today: string;
  customers: readonly CustomerOption[];
  /** The currencies enabled in Settings (`currency.enabled`), NPR first. */
  enabledCurrencies: readonly Currency[];
  initialCustomerId: string;
  /** Set when the form was opened from an invoice that still owes; null or left out starts blank. */
  prefill?: PaymentPrefill | null;
  /** Set when the invoice fixes the customer: no picker, and the customer cannot be changed. */
  fixedCustomer?: FixedCustomer | null;
  reloadHref: string;
  children?: ReactNode;
}) {
  const [state, formAction, pending] = useActionState<RecordPaymentState, FormData>(
    recordPaymentAction,
    { key: idempotencyKey },
  );
  const fe = state.fieldErrors ?? {};
  const formId = useId();

  // Controlled: React 19 resets uncontrolled fields after every action.
  const [customerId, setCustomerId] = useState(initialCustomerId);
  // An invoice's own currency is used as it is, even when switched off in Settings: a payment is still accepted in it.
  const [currency, setCurrency] = useState<string>(() =>
    prefill !== null
      ? prefill.currency
      : startCurrency(
          customers.find((c) => c.id === initialCustomerId)?.defaultCurrency,
          enabledCurrencies,
        ),
  );
  const [currencyChosen, setCurrencyChosen] = useState(false);
  const [amount, setAmount] = useState(prefill?.amount ?? '');
  const [method, setMethod] = useState<PaymentMethod>('bank_transfer');
  const [receivedOn, setReceivedOn] = useState(today);
  const [bankReference, setBankReference] = useState('');
  const [tds, setTds] = useState('');
  const [code, setCode] = useState('');

  const [proofs, setProofs] = useState<Proof[]>([]);
  const [uploading, setUploading] = useState(0);
  const pickerRef = useRef<HTMLInputElement>(null);
  const uploadBusy = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const referenceRef = useRef<HTMLDivElement>(null);
  const numberSystems = useNumberSystems();
  const referenceMatches = state.referenceMatches ?? [];

  // Send focus to what needs attention: the summary, the reused bank reference warning (nothing was
  // recorded, and the person pressed the button at the bottom), else the first field that is wrong.
  useEffect(() => {
    if (state.error) errorRef.current?.focus();
    else if (state.referenceMatches !== undefined && state.referenceMatches.length > 0)
      referenceRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  function chooseCustomer(id: string) {
    setCustomerId(id);
    const fallback = customers.find((c) => c.id === id)?.defaultCurrency;
    if (!currencyChosen) setCurrency(startCurrency(fallback, enabledCurrencies));
    // The invoice's open amount belongs to its customer: drop it unless the person has typed their own.
    if (prefill !== null && id !== prefill.customerId && amount === prefill.amount) setAmount('');
  }

  async function addFiles(files: FileList | null) {
    if (files === null || customerId === '' || uploadBusy.current) return;
    uploadBusy.current = true;
    const picked = [...files];
    const room = MAX_PROOFS - proofs.length;
    const found: string[] = [];
    const accepted = picked.slice(0, Math.max(room, 0));
    if (picked.length > accepted.length) found.push(`You can add up to ${MAX_PROOFS} files.`);

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
    uploadBusy.current = false;
    for (const message of found) toast.error(message);
    // Allow choosing the same file again after removing it.
    if (pickerRef.current) pickerRef.current.value = '';
  }

  // A switched-off currency is named on the field, never replaced: the chosen one, else the usual one.
  const currencyOptions = paymentCurrencyChoices(enabledCurrencies);
  const chosenOff = currencyOptions.find((c) => c.value === currency && !c.on);
  const usualCurrency = customers.find((c) => c.id === customerId)?.defaultCurrency ?? null;
  const currencyHint =
    chosenOff !== undefined
      ? `${CURRENCY_NAME[chosenOff.value]} is switched off in Settings. Payments in it are still recorded.`
      : usualCurrency !== null && !normalizeEnabled(enabledCurrencies).includes(usualCurrency)
        ? `This customer usually pays in ${CURRENCY_NAME[usualCurrency]}, which is switched off in Settings. Payments in it are still recorded.`
        : undefined;

  // The open amount is in the invoice's currency: in any other currency the same figure is not what the invoice owes.
  const amountHint =
    prefill !== null &&
    customerId === prefill.customerId &&
    currency === prefill.currency &&
    amount === prefill.amount
      ? `The open amount of ${prefill.invoiceNumber ?? 'the invoice'}. Change it for a part payment.`
      : 'The cash that arrived, for example 20,18,180.00.';

  const busy = pending || uploading > 0;
  const customerLocked = proofs.length > 0 || uploading > 0;

  return (
    <>
      <PageHeader
        title="Record payment"
        description="Record money received from a customer and attach proof for Finance to verify."
        actions={
          <>
            <LinkButton href="/payments" variant="secondary">
              Cancel
            </LinkButton>
            <Button type="submit" form={formId} disabled={busy} aria-busy={busy || undefined}>
              {pending ? 'Recording' : 'Record payment'}
            </Button>
          </>
        }
      />
      {children}
      <form id={formId} ref={formRef} action={formAction} noValidate className={styles.form}>
        <input type="hidden" name="idempotencyKey" value={state.key} />
        {/* The select below is locked while proof is held, and a locked select sends nothing. */}
        <input type="hidden" name="customerId" value={customerId} />
        {fixedCustomer !== null ? (
          <input type="hidden" name="invoiceId" value={fixedCustomer.invoiceId} />
        ) : null}
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

        {referenceMatches.length > 0 ? (
          <Alert
            ref={referenceRef}
            tabIndex={-1}
            tone="warning"
            role="alert"
            title="A payment with this bank reference is already recorded"
          >
            Check this is not the same payment before you record it again:
            <ul>
              {referenceMatches.map((m) => (
                <li key={m.id}>
                  <a
                    href={`/payments/${encodeURIComponent(m.id)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {m.number ?? 'Not yet numbered'}
                  </a>
                  : {money(m.amount, m.currency, numberSystems)} from{' '}
                  {m.customerName ?? 'a customer you cannot see'}, received{' '}
                  <time dateTime={m.receivedOn}>{when(m.receivedOn, 'date')}</time> (
                  {paymentStatusMeta(m.status).label})
                </li>
              ))}
            </ul>
            <label className={styles.check}>
              {/* Keyed by the list, so a new set of matches always starts unticked. */}
              <input
                key={referenceMatches.map((m) => m.id).join(',')}
                type="checkbox"
                name="referenceConfirmed"
                value={referenceMatches.map((m) => m.id).join(',')}
              />
              This is a different payment. Record it anyway.
            </label>
          </Alert>
        ) : null}

        <Panel
          title={<SectionTitle eyebrow="01 · The basics">Payment details</SectionTitle>}
          description="What the customer paid, as it appears on the bank slip."
        >
          <div className={styles.form}>
            {fixedCustomer !== null ? (
              <Field
                label="Customer"
                hint="From the invoice. Proof is stored against this customer. To pay for another customer, record the payment from Payments."
                error={fe.customerId}
              >
                {(control) => (
                  <Input value={fixedCustomer.name} readOnly autoComplete="off" {...control} />
                )}
              </Field>
            ) : (
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
            )}

            <div className={styles.grid}>
              <Field label="Currency" hint={currencyHint} error={fe.currency}>
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
                    <option value="">Choose a currency</option>
                    {currencyOptions.map((c) => (
                      <option key={c.value} value={c.value}>
                        {c.label}
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Amount received" hint={amountHint} error={fe.amount}>
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
                  <DatePicker
                    name="receivedOn"
                    required
                    max={today}
                    value={receivedOn}
                    onChange={setReceivedOn}
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
          title={<SectionTitle eyebrow="02 · The proof">Proof of payment</SectionTitle>}
          description={`A bank slip or receipt, as a PDF or a picture, up to ${MAX_PROOFS} files. Each file is checked for viruses before the payment can use it.`}
        >
          <Field
            label="Add proof files"
            hint={
              customerId === ''
                ? 'Choose the customer first.'
                : 'You can add several files at once.'
            }
            error={fe.proof}
          >
            {(control) => (
              <div className={styles.drop}>
                <Icon name="file-text" size={24} />
                <span>Drop files here or choose files</span>
                <input
                  ref={pickerRef}
                  type="file"
                  multiple
                  accept={PROOF_ACCEPT}
                  disabled={busy || customerId === '' || proofs.length >= MAX_PROOFS}
                  onChange={(e) => void addFiles(e.target.files)}
                  {...control}
                />
              </div>
            )}
          </Field>
          <p className={styles.status} role="status">
            {uploading > 0 ? `Uploading ${uploading} ${uploading === 1 ? 'file' : 'files'}…` : ''}
          </p>
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
                    <Icon name="x" size={18} />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
        </Panel>

        <p className={styles.status} role="status">
          {pending ? 'Recording the payment' : ''}
        </p>
      </form>
    </>
  );
}
