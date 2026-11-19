'use client';

import type { Currency, TaxCode } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { DatePicker } from '@/components/ui/date-picker';
import { Field, Select, Textarea } from '@/components/ui/field';
import { PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { toast } from '@/components/ui/toast';
import { currencyChoices } from '@/lib/enabled-currencies';

import { DraftSummary } from './draft-summary';
import type { InvoiceFormState } from './form-state';
import { LinesEditor, useLines } from './lines-editor';
import styles from './manual-invoice.module.css';

export interface CustomerOption {
  id: string;
  label: string;
  /** The customer's usual currency: it preselects the currency when the customer is chosen. */
  currency: Currency | null;
}

/** The manual form keeps its inputs after a refusal. Numbering, issue date and tax are server-owned. */
export function ManualInvoiceForm({
  action,
  customers,
  customersNote,
  taxCodes,
  enabledCurrencies,
  idempotencyKey,
}: {
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState>;
  customers: readonly CustomerOption[] | null;
  customersNote?: string | undefined;
  taxCodes: readonly TaxCode[] | null;
  /** The company's switched-on currencies (`currency.enabled`), read once by the page. */
  enabledCurrencies: readonly Currency[];
  /** One key per render, retained after an unknown result so a retry only creates one invoice. */
  idempotencyKey: string;
}) {
  const [state, formAction, pending] = useActionState<InvoiceFormState, FormData>(action, {
    key: idempotencyKey,
    errors: {},
  });
  const [customerId, setCustomerId] = useState('');
  const [currency, setCurrency] = useState<Currency>('NPR');
  const [manualReason, setManualReason] = useState('');
  const [dueDate, setDueDate] = useState('');
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

  const errors = state.errors;
  const customer = customers?.find((c) => c.id === customerId);
  // A new invoice offers only switched-on currencies; NPR (the default) is always among them.
  const currencies = currencyChoices(enabledCurrencies);
  const choose = (id: string): void => {
    setCustomerId(id);
    const usual = customers?.find((c) => c.id === id)?.currency;
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

      <Panel title="Customer and source">
        <div className={styles.grid}>
          <Field
            label="Organization legal name"
            error={errors['customerId']}
            hint={customersNote}
            className={styles.wide ?? ''}
          >
            {(control) => (
              <Select
                name="customerId"
                value={customerId}
                disabled={customers === null || customers.length === 0}
                onChange={(e) => choose(e.target.value)}
                {...control}
              >
                <option value="">Choose a customer</option>
                {(customers ?? []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label}
                  </option>
                ))}
              </Select>
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
        title="Invoice details"
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
            hint="Optional. Leave blank to use the customer's payment terms."
            error={errors['dueDate']}
          >
            {(control) => (
              <DatePicker name="dueDate" value={dueDate} onChange={setDueDate} {...control} />
            )}
          </Field>
        </div>
      </Panel>

      <Panel title="Line Items" className={styles.lineItems}>
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
          pending={pending}
        />
      </Panel>

      <p role="status" className="sr-only">
        {pending ? 'Saving the draft invoice' : ''}
      </p>
    </form>
  );
}
