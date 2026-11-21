import { randomUUID } from 'node:crypto';

import type { CustomerDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { isPayableSettlement } from '@/app/(app)/invoices/_lib/gates';
import { todayInKathmandu } from '@/app/(app)/settings/format';
import { getCustomer, listCustomers } from '@/components/p2/customers/api';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Field } from '@/components/ui/field';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { getInvoice } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';

import { type CustomerOption, PaymentForm, type PaymentPrefill } from './payment-form';
import styles from './payment-form.module.css';

export const metadata: Metadata = { title: 'Record payment · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The most customers one page of the picker lists; past it the person narrows the search. */
const PICKER_LIMIT = 100;

const first = (v: string | string[] | undefined): string | undefined =>
  Array.isArray(v) ? v[0] : v;

const toOption = (c: CustomerDto): CustomerOption => ({
  id: c.id,
  name: c.legalName,
  number: c.number,
  defaultCurrency: c.defaultCurrency,
});

/**
 * What a form opened from an invoice's Record payment starts on (U16-Q8 a): the invoice's currency and the open amount
 * the API derives for it, read as this person (tenant and grant scoped). The link carries only ids; an amount in the
 * query is never read. Anything off (another customer's invoice, not a payable document, settled, not found, not
 * readable, or an API that does not send the open amount) leaves the form blank, without saying why.
 */
async function invoicePrefill(
  session: Session,
  invoiceId: string,
  customerId: string,
): Promise<PaymentPrefill | null> {
  if (invoiceId === '' || customerId === '') return null;
  try {
    const detail = await getInvoice(session, invoiceId);
    const { invoice } = detail;
    if (invoice.customerId !== customerId || invoice.status !== 'issued') return null;
    if (invoice.kind !== 'tax_invoice' && invoice.kind !== 'debit_note') return null;
    if (detail.can?.recordPayment === false) return null;
    if (!isPayableSettlement(detail.settlement) || detail.openAmount == null) return null;
    return {
      customerId,
      currency: invoice.currency,
      amount: detail.openAmount,
      invoiceNumber: invoice.number,
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
    q?: string | string[];
  }>;
}) {
  const query = await searchParams;
  const rawCustomer = first(query.customerId);
  const customerId = rawCustomer !== undefined && UUID.test(rawCustomer) ? rawCustomer : '';
  const rawInvoice = first(query.invoiceId);
  const invoiceId =
    customerId !== '' && rawInvoice !== undefined && UUID.test(rawInvoice) ? rawInvoice : '';
  const q = (first(query.q) ?? '').trim().slice(0, 100);
  const params = new URLSearchParams();
  if (customerId !== '') params.set('customerId', customerId);
  if (invoiceId !== '') params.set('invoiceId', invoiceId);
  if (q !== '') params.set('q', q);
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
  let customers: CustomerOption[] = [];
  let truncated = false;
  let problem: { message: string; status: number } | null = null;
  try {
    const listing = await listCustomers(session, { q, limit: PICKER_LIMIT });
    // A merged customer is not live: the record it was merged into is the one to pay.
    customers = listing.items.filter((c) => c.mergedIntoId === null).map(toOption);
    truncated = listing.items.length >= PICKER_LIMIT || (listing.total ?? 0) > listing.items.length;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  // A customer named in the link stays choosable even when the search has pushed them off the list.
  if (problem === null && customerId !== '' && !customers.some((c) => c.id === customerId)) {
    try {
      const named = await getCustomer(session, customerId);
      if (named.mergedIntoId === null) customers = [toOption(named), ...customers];
    } catch {
      // Not found or not readable: the picker simply starts empty.
    }
  }

  const initialCustomerId = customers.some((c) => c.id === customerId) ? customerId : '';
  // Only for the customer the picker starts on: an unreadable or merged customer leaves the amount blank too.
  const prefill =
    problem === null ? await invoicePrefill(session, invoiceId, initialCustomerId) : null;

  const showSearch = q !== '' || truncated;

  const search = showSearch ? (
    <form method="get" action="/payments/new" className={styles.search}>
      <div className={styles.searchField}>
        <Field
          label="Find a customer"
          hint={
            truncated
              ? `Showing the first ${PICKER_LIMIT}. Search by name or number to narrow the list. Searching resets the form.`
              : 'Searching resets the form.'
          }
        >
          {(control) => (
            <SearchInput
              name="q"
              defaultValue={q}
              maxLength={100}
              autoComplete="off"
              {...control}
            />
          )}
        </Field>
      </div>
      <Button type="submit" variant="secondary">
        Search
      </Button>
      {q !== '' ? <Link href="/payments/new">Clear search</Link> : null}
    </form>
  ) : null;

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
            <>
              {search}
              <EmptyState
                icon="users"
                title={q !== '' ? 'No customers match that search.' : 'There are no customers yet.'}
                action={
                  q !== '' ? (
                    <LinkButton href="/payments/new" variant="secondary">
                      Clear search
                    </LinkButton>
                  ) : (
                    <LinkButton href="/customers/new" variant="secondary">
                      Add a customer
                    </LinkButton>
                  )
                }
              >
                {q !== ''
                  ? 'Try part of the name or the customer number.'
                  : 'A payment is recorded against a customer. Add the customer first.'}
              </EmptyState>
            </>
          ) : (
            <PaymentForm
              // One key per render of this page: a double click or a retry records the payment once.
              idempotencyKey={randomUUID()}
              today={todayInKathmandu()}
              customers={customers}
              enabledCurrencies={await enabledCurrencies}
              initialCustomerId={initialCustomerId}
              prefill={prefill}
              reloadHref={here}
            >
              {search}
            </PaymentForm>
          )}
        </>
      )}
    </Page>
  );
}
