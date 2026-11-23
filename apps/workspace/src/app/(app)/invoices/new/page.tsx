import { randomUUID } from 'node:crypto';

import { CUSTOMER_LIST_MAX_LIMIT, type TaxCode } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCustomers } from '@/components/p2/customers/api';
import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { failureOf } from '@/lib/api-kernel';
import { listTaxCodes } from '@/lib/api-tax-codes';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getPermissionCheck } from '@/lib/live-permissions';

import { createManualInvoiceAction } from './actions';
import { ManualInvoiceForm, type CustomerOption } from './manual-invoice-form';

export const metadata: Metadata = { title: 'Create Invoice · Business OS' };
export const dynamic = 'force-dynamic';

/** How many customers the picker holds. A longer list says so instead of silently cutting. */
const CUSTOMER_LIMIT = CUSTOMER_LIST_MAX_LIMIT;

export default async function NewInvoicePage() {
  const session = await requireStaffSession('/invoices/new');
  const crumbs = [{ label: 'Invoices', href: '/invoices' }, { label: 'Create Invoice' }];

  if (!(await getPermissionCheck(session))('invoice.draft')) {
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <PageHeader title="Create Invoice" />
        <Alert tone="info" role="status" title="Your roles do not include drafting invoices">
          Ask an administrator if you need to. You can still read invoices.
        </Alert>
      </Page>
    );
  }

  // `loadEnabledCurrencies` never throws: a failed read falls back to the default list.
  const [[customerResult, taxResult], enabledCurrencies] = await Promise.all([
    Promise.allSettled([listCustomers(session, { limit: CUSTOMER_LIMIT }), listTaxCodes(session)]),
    loadEnabledCurrencies(session),
  ]);

  if (customerResult.status === 'rejected') {
    const f = failureOf(customerResult.reason);
    return (
      <Page width="narrow">
        <Breadcrumb items={crumbs} />
        <PageHeader title="Create Invoice" />
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            f.status === 403 ? 'Your roles do not include customers' : 'The customers did not load'
          }
          actions={f.status !== 403 ? <Link href="/invoices/new">Try again</Link> : null}
        >
          {f.status === 403
            ? 'An invoice is raised for a customer, so you need to be able to read customers. Ask an administrator if you need access.'
            : f.message}
        </Alert>
      </Page>
    );
  }

  const { items, total } = customerResult.value;
  const customers: CustomerOption[] = items
    .filter((c) => c.mergedIntoId === null)
    .map((c) => ({
      id: c.id,
      label: c.legalName,
      detail: [c.number, c.panVatNo].filter(Boolean).join(' · '),
      currency: c.defaultCurrency,
    }));
  const taxCodes: TaxCode[] | null = taxResult.status === 'fulfilled' ? taxResult.value : null;
  const cut = total !== null ? total > items.length : items.length >= CUSTOMER_LIMIT;

  return (
    <Page>
      <Breadcrumb items={crumbs} />
      {customers.length === 0 ? (
        <>
          <PageHeader title="Create Invoice" />
          <Alert tone="info" role="status" title="There are no customers to invoice yet">
            Add the customer first, then come back here.
          </Alert>
        </>
      ) : (
        <ManualInvoiceForm
          action={createManualInvoiceAction}
          customers={customers}
          customersNote={
            cut
              ? `Showing the first ${items.length} customers. If yours is missing, ask an administrator to raise the invoice.`
              : undefined
          }
          taxCodes={taxCodes}
          enabledCurrencies={enabledCurrencies}
          // One key per render of this page: a double click or a retry creates the invoice once.
          idempotencyKey={randomUUID()}
        />
      )}
    </Page>
  );
}
