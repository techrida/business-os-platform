import { randomUUID } from 'node:crypto';

import type { Metadata } from 'next';

import { isPayableSettlement } from '@/app/(app)/invoices/_lib/gates';
import { todayInKathmandu } from '@/app/(app)/settings/format';
import { getCustomer, listCustomers } from '@/components/p2/customers/api';
import { Alert } from '@/components/ui/alert';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { getInvoice } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';

import { type CustomerOption, toCustomerOption } from './customer-option';
import { type FixedCustomer, PaymentForm, type PaymentPrefill } from './payment-form';

export const metadata: Metadata = { title: 'Record payment · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most customers the page hands the picker; past it the picker searches the server as the person types. */
const PICKER_LIMIT = 100;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

/**
 * What a form opened from an invoice's Record payment starts on (U16-Q8 a): the invoice's currency and the open amount
 * the API derives for it, read as this person (tenant and grant scoped). The link carries only ids; an amount in the
 * query is never read. Anything off (another customer's invoice, not a payable document, settled, not found, not
 * readable, or an API that does not send the open amount) leaves the form blank, without saying why.
 *
 * The invoice also fixes the customer (item 3b): its name comes from the invoice detail (the buyer frozen at issue,
 * else the current name the invoice read carries), so a role with invoice.read and payment.record but no
 * customer.read can record the payment. No customer read happens on this path.
 */
async function invoicePrefill(
  session: Session,
  invoiceId: string,
  customerId: string,
): Promise<{ prefill: PaymentPrefill; customer: FixedCustomer } | null> {
  if (invoiceId === '' || customerId === '') return null;
  try {
    const detail = await getInvoice(session, invoiceId);
    const { invoice } = detail;
    if (invoice.customerId !== customerId || invoice.status !== 'issued') return null;
    if (invoice.kind !== 'tax_invoice' && invoice.kind !== 'debit_note') return null;
    if (detail.can?.recordPayment === false) return null;
    if (!isPayableSettlement(detail.settlement) || detail.openAmount == null) return null;
    return {
      prefill: {
        customerId,
        currency: invoice.currency,
        amount: detail.openAmount,
        invoiceNumber: invoice.number,
      },
      customer: {
        id: customerId,
        name:
          invoice.buyer?.legalName ??
          detail.customerName ??
          `The customer on ${invoice.number ?? 'this invoice'}`,
        invoiceId,
      },
    };
  } catch {
    return null;
  }
}

function Crumbs() {
  return (
    <Breadcrumb items={[{ label: 'Payments', href: '/payments' }, { label: 'Record payment' }]} />
  );
}

export default async function NewPaymentPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{
    customerId?: string | string[];
    invoiceId?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const rawCustomer = first(query.customerId);
  const customerId = rawCustomer !== undefined && UUID.test(rawCustomer) ? rawCustomer : '';
  const rawInvoice = first(query.invoiceId);
  const invoiceId =
    customerId !== '' && rawInvoice !== undefined && UUID.test(rawInvoice) ? rawInvoice : '';
  const params = new URLSearchParams();
  if (customerId !== '') params.set('customerId', customerId);
  if (invoiceId !== '') params.set('invoiceId', invoiceId);
  const here = params.size > 0 ? `/payments/new?${params.toString()}` : '/payments/new';
  const session = await requireStaffSession(here);

  if (!(await getPermissionCheck(session))('payment.record')) {
    return (
      <Page width="narrow">
        <Crumbs />
        <PageHeader title="Record payment" />
        <Alert tone="info" role="status" title="Your roles do not include recording payments">
          Ask an administrator if you need to. You can still read payments.
        </Alert>
      </Page>
    );
  }

  // Never throws: a failed read gives the default list. It only marks which currencies are switched off;
  // a payment is accepted in any of them (U16-Q1).
  const enabledCurrencies = loadEnabledCurrencies(session);

  // Opened from an invoice that still owes: the invoice names the customer, so the picker (and its customer.read) is
  // not needed and the customer cannot be changed here. Anything off falls back to the standalone form below.
  const fromInvoice = await invoicePrefill(session, invoiceId, customerId);
  if (fromInvoice !== null) {
    return (
      <Page>
        <Crumbs />
        <PaymentForm
          // One key per render of this page: a double click or a retry records the payment once.
          idempotencyKey={randomUUID()}
          today={todayInKathmandu()}
          customers={[]}
          enabledCurrencies={await enabledCurrencies}
          initialCustomerId={fromInvoice.customer.id}
          fixedCustomer={fromInvoice.customer}
          prefill={fromInvoice.prefill}
          reloadHref={here}
        />
      </Page>
    );
  }

  let customers: CustomerOption[] = [];
  let truncated = false;
  let problem: { message: string; status: number } | null = null;
  try {
    const listing = await listCustomers(session, { limit: PICKER_LIMIT });
    // A merged customer is not live: the record it was merged into is the one to pay.
    customers = listing.items.filter((c) => c.mergedIntoId === null).map(toCustomerOption);
    truncated = listing.items.length >= PICKER_LIMIT || (listing.total ?? 0) > listing.items.length;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  // A customer named in the link stays choosable even when the list is cut off before them.
  if (problem === null && customerId !== '' && !customers.some((c) => c.id === customerId)) {
    try {
      const named = await getCustomer(session, customerId);
      if (named.mergedIntoId === null) customers = [toCustomerOption(named), ...customers];
    } catch {
      // Not found or not readable: the picker simply starts empty.
    }
  }

  const initialCustomerId = customers.some((c) => c.id === customerId) ? customerId : '';

  return (
    <Page>
      <Crumbs />
      {problem !== null || customers.length === 0 ? <PageHeader title="Record payment" /> : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include customers'
              : 'The customers did not load'
          }
          actions={problem.status !== 403 ? <a href={here}>Reload the form</a> : null}
        >
          {problem.status === 403
            ? 'Choosing the customer who paid needs access to customers. Ask an administrator if you need it.'
            : problem.message}
        </Alert>
      ) : (
        <>
          {customers.length === 0 ? (
            <EmptyState
              icon="users"
              title="There are no customers yet."
              action={
                <LinkButton href="/customers/new" variant="secondary">
                  Add a customer
                </LinkButton>
              }
            >
              A payment is recorded against a customer. Add the customer first.
            </EmptyState>
          ) : (
            <PaymentForm
              // One key per render of this page: a double click or a retry records the payment once.
              idempotencyKey={randomUUID()}
              today={todayInKathmandu()}
              customers={customers}
              customersCutOff={truncated}
              enabledCurrencies={await enabledCurrencies}
              initialCustomerId={initialCustomerId}
              reloadHref={here}
            />
          )}
        </>
      )}
    </Page>
  );
}
