'use client';

import { CURRENCIES, type Currency, type TaxCode } from '@bos/contracts';
import { useActionState, useEffect, useRef, useState } from 'react';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { Field, Input, Select, Textarea } from '@/components/ui/field';
import { Panel } from '@/components/ui/panel';

import type { InvoiceFormState } from './form-state';
import { LinesEditor, useLines } from './lines-editor';
import styles from './manual-invoice.module.css';

export interface CustomerOption {
  id: string;
  label: string;
  /** The customer's usual currency: it preselects the currency when the customer is chosen. */
  currency: Currency | null;
}

const CURRENCY_LABEL: Record<Currency, string> = {
  NPR: 'NPR (Nepalese rupee)',
  INR: 'INR (Indian rupee)',
  USD: 'USD (US dollar)',
};

/**
 * The manual invoice form: customer, currency, why it has no sales order, an optional due date and
 * the lines. No number, no issue date and no totals: the server sets the first two when the invoice
 * is issued and works out the totals on save, and the person reads them on the invoice page.
 * Inputs are controlled so a refusal does not wipe what was typed (React 19 resets uncontrolled
 * fields after every action).
 */
export function ManualInvoiceForm({
  action,
  customers,
  customersNote,
  taxCodes,
  idempotencyKey,
}: {
  action: (prev: InvoiceFormState, form: FormData) => Promise<InvoiceFormState>;
  /** null when the customer list failed to load. */
  customers: readonly CustomerOption[] | null;
  /** Said under the customer field when the list is cut short or empty. */
  customersNote?: string | undefined;
  taxCodes: readonly TaxCode[] | null;
  /** A UUID the server made for this render: a double click or a retry creates the invoice once. */
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

  // Send focus to what needs attention: the summary, else the first field that is wrong.
  useEffect(() => {
    if (state.error || state.errors['form']) summaryRef.current?.focus();
    else formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
  }, [state]);

  const errors = state.errors;
  const choose = (id: string): void => {
    setCustomerId(id);
    const usual = customers?.find((c) => c.id === id)?.currency;
    if (usual) setCurrency(usual);
  };

  return (
    <form ref={formRef} action={formAction} noValidate className={styles.form}>
      <input type="hidden" name="idempotencyKey" value={state.key} />
      <input type="hidden" name="lines" value={JSON.stringify(lines)} />

      {state.error || errors['form'] ? (
        <Alert
          ref={summaryRef}
          tabIndex={-1}
          tone="error"
          role="alert"
          title="Nothing was saved"
          actions={
            state.reload ? (
              // A plain anchor on purpose: a full page load clears the form and its idempotency key,
              // which a client-side <Link> to the same URL would keep.
              // eslint-disable-next-line @next/next/no-html-link-for-pages
              <a href="/invoices/new">Reload this page</a>
            ) : null
          }
        >
          {state.error ?? errors['form']}
        </Alert>
      ) : null}

      <Panel
        title="Invoice"
        description="The platform sets the number and the issue date when the invoice is issued."
      >
        <div className={styles.grid}>
          <Field label="Customer" error={errors['customerId']} hint={customersNote}>
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
          <Field label="Currency" error={errors['currency']}>
            {(control) => (
              <Select
                name="currency"
                value={currency}
                onChange={(e) => setCurrency(e.target.value as Currency)}
                {...control}
              >
                {CURRENCIES.map((c) => (
                  <option key={c} value={c}>
                    {CURRENCY_LABEL[c]}
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
              <Input
                name="dueDate"
                type="date"
                value={dueDate}
                onChange={(e) => setDueDate(e.target.value)}
                {...control}
              />
            )}
          </Field>
          <Field
            label="Why is there no sales order?"
            hint="Kept on the invoice and shown to the approvers."
            error={errors['manualReason']}
            className={styles.wide ?? ''}
          >
            {(control) => (
              <Textarea
                name="manualReason"
                rows={3}
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
        title="Lines"
        description="Quantity and price per unit. The platform works out the amounts, the tax and the totals."
      >
        <LinesEditor
          lines={lines}
          currency={currency}
          taxCodes={taxCodes}
          errors={errors}
          onChange={setLine}
          onAdd={add}
          onRemove={remove}
        />
      </Panel>

      <div className={styles.actions}>
        <Button type="submit" disabled={pending}>
          {pending ? 'Saving' : 'Save draft invoice'}
        </Button>
        <LinkButton variant="secondary" href="/invoices">
          Cancel
        </LinkButton>
        <p role="status" className={styles.status}>
          {pending ? 'Saving the draft invoice' : ''}
        </p>
      </div>
    </form>
  );
}
