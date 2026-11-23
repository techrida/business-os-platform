'use client';

import type { Currency, TaxCode } from '@bos/contracts';
import { Dec, formatMoney, plainAmount } from '@bos/locale';
import { type ReactNode, useActionState, useEffect, useMemo, useRef, useState } from 'react';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Combobox } from '@/components/ui/combobox';
import { matchesQuery } from '@/components/ui/combobox-model';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Select, Textarea } from '@/components/ui/field';
import { MoneyInput, PercentInput } from '@/components/ui/number-input';
import { useNumberSystems } from '@/components/ui/number-system-context';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { currencyChoices } from '@/lib/enabled-currencies';

import { DraftSummary } from './draft-summary';
import type { InvoiceFormState } from './form-state';
import { type DiscountMode, parseDiscount } from './forms';
import { LinesEditor, useLines } from './lines-editor';
import type { LineValues } from './lines';
import styles from './manual-invoice.module.css';
import type { CustomerOption } from './customer-option';

export type { CustomerOption };

/** What the picker asks when the page's list was cut off: the customers matching the typed text. */
export type CustomerSearcher = (text: string, signal: AbortSignal) => Promise<CustomerOption[]>;

/** The BFF route beside this page; throws on any failure (the picker then says the search did not load). */
export const searchCustomers: CustomerSearcher = async (text, signal) => {
  const res = await fetch(
    `/invoices/new/customers?${new URLSearchParams({ q: text }).toString()}`,
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
/** Shorter text is matched against the page's own list only. */
const CUSTOMER_SEARCH_MIN_CHARS = 2;

const PLAIN_DECIMAL = /^(\d+\.?\d*|\.\d+)$/;
const HUNDRED = new Dec(100);

/**
 * The subtotal before tax the discount applies to: each line's quantity times price at 2 decimals, summed, as the
 * summary and the server work it out. Null while any line's quantity or price is not a number yet.
 */
function discountBase(lines: readonly LineValues[]): Dec | null {
  let total = new Dec(0);
  for (const line of lines) {
    const quantity = plainAmount(line.quantity);
    const price = plainAmount(line.unitPrice);
    if (!PLAIN_DECIMAL.test(quantity) || !PLAIN_DECIMAL.test(price)) return null;
    total = total.plus(new Dec(quantity).times(price).toDecimalPlaces(2));
  }
  return lines.length > 0 ? total : null;
}

/**
 * The side the person did not type, worked out from the side they did. The amount is rounded half-up to 2 decimals
 * as the server rounds it; the percentage to 4 decimals with trailing zeros dropped (`5`, not `5.0000`). Blank when
 * there is nothing to work from, or when the amount is more than the base (that is flagged on the amount instead).
 */
function derivedDiscount(mode: DiscountMode, value: string, base: Dec | null): string {
  if (mode === 'none' || base === null) return '';
  const plain = plainAmount(value);
  if (!PLAIN_DECIMAL.test(plain)) return '';
  if (mode === 'pct') return base.times(plain).div(HUNDRED).toDecimalPlaces(2).toFixed(2);
  if (base.isZero() || new Dec(plain).gt(base)) return '';
  return new Dec(plain).div(base).times(HUNDRED).toDecimalPlaces(4).toFixed();
}

/**
 * Card heading with the eyebrow Figma shows above it ("01 · The basics", "02 · The story"), the same treatment as the
 * create-lead form. The eyebrow is decoration, so screen readers hear only the heading.
 */
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

/** The manual form keeps its inputs after a refusal. Numbering, issue date and tax are server-owned. */
export function ManualInvoiceForm({
  action,
  customers,
  customersCutOff = false,
  search = searchCustomers,
  taxCodes,
  enabledCurrencies,
  idempotencyKey,
  today = todayInKathmandu(),
}: {
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState>;
  customers: readonly CustomerOption[] | null;
  /** The page's list is only the first customers: the picker asks the server while the person types. */
  customersCutOff?: boolean;
  /** Where a cut-off list's matches come from; the BFF route by default. */
  search?: CustomerSearcher;
  taxCodes: readonly TaxCode[] | null;
  /** The company's switched-on currencies (`currency.enabled`), read once by the page. */
  enabledCurrencies: readonly Currency[];
  /** One key per render, retained after an unknown result so a retry only creates one invoice. */
  idempotencyKey: string;
  /** Today as `YYYY-MM-DD`, the earliest due date the picker offers. */
  today?: string | undefined;
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [customerId, setCustomerId] = useState('');
  const [customerOpen, setCustomerOpen] = useState(false);
  // The customers the picker knows: the page's list plus whatever a search of a cut-off list has found since.
  const [searched, setSearched] = useState<readonly CustomerOption[]>([]);
  const [customerText, setCustomerText] = useState('');
  // The server's answer for the text it was asked about, so a match it found by a fuzzier or normalised rule is listed.
  const [found, setFound] = useState<{ query: string; items: readonly CustomerOption[] } | null>(
    null,
  );
  // The server search for the typed text did not load: say so instead of "No matching customer.".
  const [searchFailed, setSearchFailed] = useState(false);
  const known = useMemo(() => {
    const byId = new Map<string, CustomerOption>();
    for (const c of [...(customers ?? []), ...searched]) if (!byId.has(c.id)) byId.set(c.id, c);
    return [...byId.values()];
  }, [customers, searched]);
  const query = customerText.trim();
  const customerOptions = useMemo(() => {
    const toOption = (c: CustomerOption) => ({ id: c.id, label: c.label, description: c.detail });
    if (!customersCutOff) return known.map(toOption);
    // The chosen customer stays listed even when it came from a search, so the closed box can still read its name.
    const chosen = known.find((c) => c.id === customerId);
    const own = customers ?? [];
    if (query === '')
      return (chosen && !own.includes(chosen) ? [...own, chosen] : own).map(toOption);
    // The answer for this very text as the server gave it; until it arrives, what is already known narrowed by the text.
    if (found?.query === query) return found.items.map(toOption);
    return known.map(toOption).filter((o) => matchesQuery(o, query));
  }, [known, customers, customersCutOff, customerId, query, found]);
  useEffect(() => {
    if (!customersCutOff || query.length < CUSTOMER_SEARCH_MIN_CHARS) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      search(query, controller.signal).then(
        (items) => {
          if (controller.signal.aborted) return;
          setSearched((old) => [...old, ...items]);
          setFound({ query, items });
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
  }, [query, customersCutOff, search]);
  // Nothing matched. A list the page did not cut off is complete; a cut-off one is only sure once the server has
  // answered for this text.
  const noMatchText = !customersCutOff
    ? 'No matching customer. Add the customer first.'
    : searchFailed
      ? 'Search did not load. Try again.'
      : query.length < CUSTOMER_SEARCH_MIN_CHARS
        ? `Not in the first ${customers?.length ?? 0} customers. Find it on the Customers list.`
        : found?.query === query
          ? 'No matching customer. Add the customer first.'
          : 'Searching…';
  const [currency, setCurrency] = useState<Currency>('NPR');
  const [manualReason, setManualReason] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [discountMode, setDiscountMode] = useState<DiscountMode>('none');
  const [discountValue, setDiscountValue] = useState('');
  const { lines, setLine, add, remove } = useLines(1);
  const formRef = useRef<HTMLFormElement>(null);
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (state.error || state.errors['form']) {
      toast.error('Invoice draft was not saved');
      summaryRef.current?.focus();
    } else if (Object.keys(state.errors).length > 0) {
      toast.error('Check the highlighted fields');
      formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
    }
  }, [state]);

  const numberSystems = useNumberSystems();
  const errors = state.errors;
  const customer = known.find((c) => c.id === customerId);
  const discount = parseDiscount(discountMode, discountValue);
  // The side typed last is the one posted; the other is worked out from it and the subtotal, so a
  // changed line price moves only the worked-out side. Emptying either side means no discount.
  const base = discountBase(lines);
  const derived = derivedDiscount(discountMode, discountValue, base);
  const percentShown = discountMode === 'pct' ? discountValue : derived;
  const amountShown = discountMode === 'amount' ? discountValue : derived;
  const editDiscount = (mode: Exclude<DiscountMode, 'none'>) => (value: string) => {
    setDiscountMode(value === '' ? 'none' : mode);
    setDiscountValue(value);
  };
  const plainTyped = plainAmount(discountValue);
  const overBase =
    discountMode === 'amount' &&
    base !== null &&
    PLAIN_DECIMAL.test(plainTyped) &&
    new Dec(plainTyped).gt(base)
      ? `Enter no more than the subtotal before tax, ${formatMoney(base.toFixed(2), currency, { numberSystems })}.`
      : undefined;
  // A new invoice offers only switched-on currencies; NPR (the default) is always among them.
  const currencies = currencyChoices(enabledCurrencies);
  const choose = (id: string): void => {
    setCustomerId(id);
    const usual = known.find((c) => c.id === id)?.currency;
    // A usual currency that has since been switched off is not preselected: the select would blank.
    if (usual && currencies.some((o) => o.value === usual)) setCurrency(usual);
  };

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      <PageHeader
        title="Create Invoice"
        description="Draft an invoice for work billed directly to a customer."
        actions={
          <>
            <LinkButton variant="secondary" href="/invoices">
              Cancel
            </LinkButton>
            <Button type="submit" disabled={pending}>
              {pending ? 'Saving' : 'Save draft invoice'}
            </Button>
          </>
        }
      />

      {state.error || errors['form'] ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title="Nothing was saved"
          actions={
            state.reload ? (
              // A full page load clears out-of-date form state and its idempotency key.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a href="/invoices/new">Reload this page</a>
            ) : null
          }
        >
          {state.error ?? errors['form']}
        </Alert>
      ) : null}

      <Panel title={<SectionTitle eyebrow="01 · The basics">Customer and source</SectionTitle>}>
        <div className={styles.grid}>
          <Field
            label="Organization legal name"
            error={errors['customerId']}
            className={styles.wide ?? ''}
          >
            {(control) => (
              // One search-as-you-type box (UIP-FORM-009); `name` posts the chosen id as the select did. An invoice
              // is raised for a customer that exists, so there is no Create row: the customer is added on
              // Customers first. A list the page cut off asks the server while the person types.
              <Combobox
                id={control.id}
                labelledBy={control['aria-labelledby']}
                describedBy={control['aria-describedby']}
                invalid={control['aria-invalid'] === true}
                name="customerId"
                searchIcon
                // Customers carry no group: a long list stays flat instead of showing an "Unassigned" header.
                groupThreshold={Number.POSITIVE_INFINITY}
                options={customerOptions}
                value={customerId}
                onChange={choose}
                open={customerOpen}
                onOpenChange={(open) => {
                  setCustomerOpen(open);
                  // Closing ends the search: the box reads the chosen name again and the full list is back.
                  if (!open) {
                    setCustomerText('');
                    setSearchFailed(false);
                  }
                }}
                onInputChange={(text) => {
                  setCustomerText(text);
                  // A new text is a new search: typing again is how a failed one is retried.
                  setSearchFailed(false);
                }}
                {...(customersCutOff ? { serverFiltered: true } : {})}
                disabled={customers === null || customers.length === 0}
                placeholder="Search by name, number or PAN"
                // A server-filtered list is empty when nothing matched, and the box then shows `emptyText`, not
                // `noMatchText`: with customers on the page that is the same message.
                emptyText={
                  customers !== null && customers.length > 0
                    ? noMatchText
                    : 'There are no customers to invoice yet.'
                }
                noMatchText={noMatchText}
              />
            )}
          </Field>
          <Field
            label="Why is there no sales order?"
            hint="Shown to the approvers."
            error={errors['manualReason']}
            className={styles.wide ?? ''}
          >
            {(control) => (
              <Textarea
                name="manualReason"
                rows={2}
                maxLength={1000}
                value={manualReason}
                onChange={(e) => setManualReason(e.target.value)}
                {...control}
              />
            )}
          </Field>
        </div>
      </Panel>

      <Panel
        title={<SectionTitle eyebrow="01 · The basics">Invoice details</SectionTitle>}
        description="The invoice number and issue date are assigned at issue."
      >
        <div className={styles.grid}>
          <Field label="Currency" error={errors['currency']}>
            {(control) => (
              <Select
                name="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                {...control}
              >
                {currencies.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field
            label="Due date"
            optional
            hint="Leave blank to use the customer's payment terms."
            error={errors['dueDate']}
          >
            {(control) => (
              <DatePicker
                name="dueDate"
                value={dueDate}
                min={today}
                onChange={setDueDate}
                {...control}
              />
            )}
          </Field>
          {/* One discount is posted: its type and the value of the side typed last. */}
          <input type="hidden" name="discountMode" value={discountMode} />
          <div className={styles.discountPair}>
            <Field
              label="Discount %"
              optional
              hint="Applies to the whole invoice, before tax."
              error={discountMode === 'pct' ? errors['discount'] : undefined}
            >
              {(control) => (
                <PercentInput
                  {...control}
                  name={discountMode === 'pct' ? 'discountValue' : undefined}
                  value={percentShown}
                  onValueChange={editDiscount('pct')}
                  onUserEdit={editDiscount('pct')}
                />
              )}
            </Field>
            <Field
              label={`Discount amount (${currency})`}
              optional
              hint="Kept in step with the percentage."
              error={overBase ?? (discountMode === 'amount' ? errors['discount'] : undefined)}
            >
              {(control) => (
                <MoneyInput
                  {...control}
                  name={discountMode === 'amount' ? 'discountValue' : undefined}
                  currency={currency}
                  max={base?.toFixed(2)}
                  value={amountShown}
                  onValueChange={editDiscount('amount')}
                  onUserEdit={editDiscount('amount')}
                />
              )}
            </Field>
          </div>
        </div>
      </Panel>

      <Panel
        title={<SectionTitle eyebrow="02 · The story">Line Items</SectionTitle>}
        className={styles.lineItems}
      >
        <LinesEditor
          lines={lines}
          currency={currency}
          taxCodes={taxCodes}
          errors={errors}
          onChange={setLine}
          onAdd={add}
          onRemove={remove}
          layout="invoice"
        />
        <DraftSummary
          customer={customer?.label}
          currency={currency}
          lines={lines}
          discount={discount.ok ? discount.data : undefined}
          pending={pending}
        />
      </Panel>

      <p role="status" className="sr-only">
        {pending ? 'Saving the draft invoice' : ''}
      </p>
    </form>
  );
}
