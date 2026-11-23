'use client';

import {
  CURRENCIES,
  type Currency,
  MONEY_LIMITS,
  PAYMENT_METHODS,
  type PaymentMethod,
} from '@bos/contracts';
import { amountInWords, Dec, postedAmount } from '@bos/locale';
import {
  type FormEvent,
  type ReactNode,
  useActionState,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { type ComboboxOption, matchesQuery } from '@/components/ui/combobox-model';
import { Field, Input, Select } from '@/components/ui/field';
import { DatePicker } from '@/components/ui/date-picker';
import { Dialog } from '@/components/ui/dialog';
import { Icon } from '@/components/ui/icon';
import {
  DecimalInput,
  MoneyInput,
  type NumberInputCommonProps,
} from '@/components/ui/number-input';
import { PageHeader } from '@/components/ui/page';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { toast } from '@/components/ui/toast';
import { FactList, Panel } from '@/components/ui/panel';
import { CURRENCY_NAME, normalizeEnabled } from '@/lib/enabled-currencies';
import { money, when } from '@/lib/kernel-format';

import { methodLabel, paymentStatusMeta } from '../_lib/status';

import type { CustomerOption } from './customer-option';

import { recordPaymentAction } from './actions';
import type { RecordPaymentState } from './form-state';
import styles from './payment-form.module.css';
import { MAX_PROOFS, PROOF_ACCEPT, proofProblem } from './proof-rules';
import { Checkbox } from '@/components/ui/checkbox';

export type { CustomerOption };

/** What the picker asks when the page's list was cut off: the customers matching the typed text. */
export type CustomerSearcher = (text: string, signal: AbortSignal) => Promise<CustomerOption[]>;

/** The BFF route beside this page; throws on any failure (the picker then simply offers no more suggestions). */
export const searchCustomers: CustomerSearcher = async (text, signal) => {
  const res = await fetch(
    `/payments/new/customers?${new URLSearchParams({ q: text }).toString()}`,
    {
      cache: 'no-store',
      signal,
    },
  );
  if (!res.ok) throw new Error(`Customer search failed with ${res.status}`);
  const body = (await res.json()) as { customers?: CustomerOption[] };
  return body.customers ?? [];
};

/** How long typing must pause before the picker asks the server. */
const CUSTOMER_SEARCH_DELAY_MS = 250;

/** The number and PAN/VAT under a customer's name in the list: what the search also matches on. */
const customerDetail = (c: CustomerOption): string =>
  [c.number, c.panVatNo].filter(Boolean).join(' · ');

const customerOption = (c: CustomerOption): ComboboxOption => ({
  id: c.id,
  label: c.name,
  description: customerDetail(c),
});

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
 *
 * Record payment does not post straight away: once the browser's own field checks pass it opens a
 * review of who paid, how much (in figures and words), the currency, the date and the reference.
 * Confirm there submits the form as it stands; Back or Escape returns to it untouched.
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

/**
 * An amount in the form's currency. Until a currency is chosen there is no code to show or grouping
 * to follow, so the box takes the same digits ungrouped; choosing one regroups what was typed.
 */
function AmountInput({ currency, ...rest }: NumberInputCommonProps & { currency: string }) {
  const chosen = CURRENCIES.find((c) => c === currency);
  return chosen === undefined ? (
    <DecimalInput {...rest} intDigits={MONEY_LIMITS.intDigits} scale={MONEY_LIMITS.scale} />
  ) : (
    <MoneyInput {...rest} currency={chosen} />
  );
}

export function PaymentForm({
  idempotencyKey,
  today,
  customers,
  customersCutOff = false,
  search = searchCustomers,
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
  /**
   * The list above is only the first page of a longer one: typing then also asks the server, so any customer can be
   * found. A complete list is searched in the browser.
   */
  customersCutOff?: boolean;
  /** Where the suggestions of a cut-off list come from. */
  search?: CustomerSearcher;
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
  // The customers the picker knows: the page's list plus whatever a search of a cut-off list has found since.
  const [searched, setSearched] = useState<readonly CustomerOption[]>([]);
  // The box's text. Only a cut-off list lets the form own it (the server's matches are not filtered again here), so it
  // starts on the chosen customer's name; a complete list leaves the text to the combobox.
  const [customerText, setCustomerText] = useState(
    customersCutOff ? (customers.find((c) => c.id === initialCustomerId)?.name ?? '') : '',
  );
  // The server's answer for the text it was asked about, so a match it found by a fuzzier or normalised rule is listed.
  const [found, setFound] = useState<{ query: string; items: readonly CustomerOption[] } | null>(
    null,
  );
  // The server search for the typed text did not load: say so instead of "No matching customer.".
  const [searchFailed, setSearchFailed] = useState(false);
  const [customerOpen, setCustomerOpen] = useState(false);
  const known = useMemo(() => {
    const byId = new Map<string, CustomerOption>();
    for (const c of [...customers, ...searched]) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  }, [customers, searched]);
  const customerOptions = useMemo(() => {
    if (!customersCutOff) return known.map(customerOption);
    const query = customerText.trim();
    if (query === '') return customers.map(customerOption);
    // The answer for this very text as the server gave it; until it arrives, what is already known narrowed by the text.
    if (found?.query === query) return found.items.map(customerOption);
    return known.map(customerOption).filter((o) => matchesQuery(o, query));
  }, [known, customers, customersCutOff, customerText, found]);
  const customerNoMatchText = searchFailed
    ? 'Search did not load. Try again.'
    : 'No matching customer.';
  const chosenName = known.find((c) => c.id === customerId)?.name;
  useEffect(() => {
    const text = customerText.trim();
    // The name of the chosen customer is not a search.
    if (!customersCutOff || text.length < 2 || text === chosenName) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(text, controller.signal).then(
        (items) => {
          if (controller.signal.aborted) return;
          setSearched((old) => [...old, ...items]);
          setFound({ query: text, items });
        },
        () => {
          // The list stays as it is (the page's own customers can still be chosen); the empty state says so.
          if (!controller.signal.aborted) setSearchFailed(true);
        },
      );
    }, CUSTOMER_SEARCH_DELAY_MS);
    // A new keystroke (or unmount) cancels the wait and the request in flight, so a slow old answer never lands.
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [customerText, customersCutOff, chosenName, search]);
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
  // Set on the person's first edit of the amount. A typed figure padded on blur can read exactly like
  // the invoice's open amount, so "untouched" is tracked, never worked out by comparing the text.
  const [amountTouched, setAmountTouched] = useState(false);
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
  const [reviewOpen, setReviewOpen] = useState(false);
  // Set by Confirm so the submit it starts goes through to the action instead of reopening the review.
  const confirmed = useRef(false);
  // Set by the first Confirm click: a second click before React re-renders must not post again.
  const confirming = useRef(false);
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
    if (customersCutOff && id !== '') setCustomerText(known.find((c) => c.id === id)?.name ?? '');
    const fallback = known.find((c) => c.id === id)?.defaultCurrency;
    if (!currencyChosen) setCurrency(startCurrency(fallback, enabledCurrencies));
    // The invoice's open amount belongs to its customer: drop it unless the person has typed their own.
    if (prefill !== null && id !== prefill.customerId && !amountTouched) setAmount('');
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
  const usualCurrency = known.find((c) => c.id === customerId)?.defaultCurrency ?? null;
  const currencyHint =
    chosenOff !== undefined
      ? `${CURRENCY_NAME[chosenOff.value]} is switched off in Settings. Payments in it are still recorded.`
      : usualCurrency !== null && !normalizeEnabled(enabledCurrencies).includes(usualCurrency)
        ? `This customer usually pays in ${CURRENCY_NAME[usualCurrency]}, which is switched off in Settings. Payments in it are still recorded.`
        : undefined;

  // The open amount is in the invoice's currency: in any other currency the same figure is not what the invoice owes.
  const showsOpenAmount =
    prefill !== null &&
    !amountTouched &&
    amount !== '' &&
    customerId === prefill.customerId &&
    currency === prefill.currency;
  const amountHint = showsOpenAmount
    ? `The open amount of ${prefill?.invoiceNumber ?? 'the invoice'}. Change it for a part payment.`
    : undefined;

  const busy = pending || uploading > 0;
  const customerLocked = proofs.length > 0 || uploading > 0;

  /**
   * Opens the review once the browser's own field checks pass. A form with a missing or malformed
   * field skips the review and goes to the action, which answers with the inline messages as before.
   */
  function requestReview() {
    const form = formRef.current;
    if (busy || form === null) return;
    // The amount box is plain text, so the browser's check does not see a zero; the action does.
    // The customer box is a combobox, which the browser's own check does not see as required.
    if (
      !form.checkValidity() ||
      !/[1-9]/.test(amount) ||
      (fixedCustomer === null && customerId === '')
    ) {
      confirmed.current = true;
      form.requestSubmit();
      return;
    }
    confirming.current = false;
    setReviewOpen(true);
  }

  function onSubmit(event: FormEvent<HTMLFormElement>) {
    // The submit Confirm started goes on to the action, with the form exactly as it stands.
    if (confirmed.current) {
      confirmed.current = false;
      return;
    }
    // Any other submit (Enter in a field) opens the review first.
    event.preventDefault();
    requestReview();
  }

  function confirmReview() {
    if (confirming.current || busy) return;
    confirming.current = true;
    confirmed.current = true;
    setReviewOpen(false);
    formRef.current?.requestSubmit();
  }

  const reviewCurrency = CURRENCIES.find((c) => c === currency);
  const reviewCustomer = known.find((c) => c.id === customerId);
  const reviewPayer =
    fixedCustomer !== null
      ? fixedCustomer.name
      : reviewCustomer !== undefined
        ? `${reviewCustomer.name} (${reviewCustomer.number})`
        : '';
  const reviewAmount =
    reviewCurrency !== undefined ? money(amount, reviewCurrency, numberSystems) : amount;
  const reviewWords =
    reviewCurrency !== undefined && /^\d+(\.\d+)?$/.test(amount)
      ? amountInWords(amount, reviewCurrency, numberSystems[reviewCurrency])
      : null;
  // Tax withheld changes what the payment settles, so the review shows it (and its code) when one is entered.
  const withheld = postedAmount(tds);
  const reviewWithheld =
    reviewCurrency !== undefined && /^\d+(\.\d+)?$/.test(withheld) && new Dec(withheld).gt(0)
      ? money(withheld, reviewCurrency, numberSystems)
      : null;
  const reviewFacts = [
    { key: 'payer', label: 'Received from', value: reviewPayer },
    { key: 'amount', label: 'Amount', value: reviewAmount },
    ...(reviewWords !== null
      ? [{ key: 'words', label: 'Amount in words', value: reviewWords }]
      : []),
    {
      key: 'currency',
      label: 'Currency',
      value: reviewCurrency !== undefined ? CURRENCY_NAME[reviewCurrency] : currency,
    },
    { key: 'receivedOn', label: 'Received on', value: when(receivedOn, 'date') },
    {
      key: 'reference',
      label: 'Bank reference',
      value: bankReference.trim() !== '' ? bankReference : 'None given',
    },
    ...(reviewWithheld !== null
      ? [
          { key: 'tdsWithheld', label: 'Tax withheld', value: reviewWithheld },
          {
            key: 'withholdingCode',
            label: 'Withholding code',
            value: code.trim() !== '' ? code.trim() : 'None given',
          },
        ]
      : []),
  ];

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
            <Dialog
              // The Record button is the dialog's trigger, so Back and Escape hand focus back to it.
              trigger={
                <Button
                  // Still the form's submit button, so Enter in a text field presses it.
                  type="submit"
                  form={formId}
                  // aria-disabled, not disabled: a focused button that turns disabled drops focus to the
                  // page body, and focus is here while a confirmed payment records. requestReview
                  // ignores presses while busy, so nothing posts twice.
                  aria-disabled={busy || undefined}
                  aria-busy={busy || undefined}
                  onClick={(event) => {
                    // Stops both the submit and the trigger's own toggle: the review opens only once
                    // the field checks pass.
                    event.preventDefault();
                    requestReview();
                  }}
                >
                  {pending ? 'Recording' : 'Record payment'}
                </Button>
              }
              open={reviewOpen}
              onOpenChange={setReviewOpen}
              title="Check the payment before you record it"
              description="Finance verifies the payment against these details and the proof."
              footer={
                <>
                  <Button type="button" variant="secondary" onClick={() => setReviewOpen(false)}>
                    Back
                  </Button>
                  <Button
                    type="button"
                    disabled={busy}
                    aria-busy={busy || undefined}
                    onClick={confirmReview}
                  >
                    Confirm
                  </Button>
                </>
              }
            >
              <FactList facts={reviewFacts} />
            </Dialog>
          </>
        }
      />
      {children}
      <form
        id={formId}
        ref={formRef}
        action={formAction}
        onSubmit={onSubmit}
        noValidate
        className={styles.form}
      >
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
              <Checkbox
                key={referenceMatches.map((m) => m.id).join(',')}
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
                  // One search-as-you-type box (UIP-FORM-009). The customerId hidden input above posts the choice:
                  // a locked box posts nothing of its own.
                  <Combobox
                    id={control.id}
                    labelledBy={control['aria-labelledby']}
                    describedBy={control['aria-describedby']}
                    invalid={control['aria-invalid'] === true}
                    required
                    searchIcon
                    options={customerOptions}
                    // Customers have no group: however long the list, no "Unassigned" header.
                    groupThreshold={Number.POSITIVE_INFINITY}
                    value={customerId}
                    onChange={chooseCustomer}
                    onInputChange={(text) => {
                      setCustomerText(text);
                      // A new text is a new search: typing again is how a failed one is retried.
                      setSearchFailed(false);
                      // Editing the name after a pick means that customer is no longer the one named.
                      if (customersCutOff && customerId !== '' && text !== chosenName) {
                        chooseCustomer('');
                      }
                    }}
                    {...(customersCutOff ? { serverFiltered: true, inputValue: customerText } : {})}
                    open={customerOpen}
                    onOpenChange={setCustomerOpen}
                    disabled={customerLocked}
                    placeholder="Search by name, number or PAN"
                    // A server-filtered list is empty when nothing matched, so the same words say both.
                    emptyText={
                      customersCutOff
                        ? customerNoMatchText
                        : 'There are no customers to choose from.'
                    }
                    noMatchText={customerNoMatchText}
                  />
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
                      const next = e.target.value;
                      // The untouched open amount is a figure in the invoice's currency: in another currency the
                      // person enters what arrived. An amount they typed is never cleared.
                      if (showsOpenAmount && next !== prefill?.currency) setAmount('');
                      setCurrency(next);
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
                  // A retyped amount equal to the open one posts the same value, so the edit is read from the input event.
                  <div onInput={() => setAmountTouched(true)}>
                    <AmountInput
                      {...control}
                      currency={currency}
                      name="amount"
                      placeholder="25,000.00"
                      required
                      min="0.01"
                      value={amount}
                      onValueChange={(next) => {
                        setAmount(next);
                        setAmountTouched(true);
                      }}
                    />
                  </div>
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
              optional
              hint="The transaction or cheque number on the slip, so Finance can match it."
              error={fe.bankReference}
            >
              {(control) => (
                <Input
                  name="bankReference"
                  placeholder="TXN-20481"
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
                  optional
                  hint="The amount withheld and not sent."
                  error={fe.tdsWithheld}
                >
                  {(control) => (
                    <AmountInput
                      {...control}
                      currency={currency}
                      name="tdsWithheld"
                      placeholder="0.00"
                      value={tds}
                      onValueChange={setTds}
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
