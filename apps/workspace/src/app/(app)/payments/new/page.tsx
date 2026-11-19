import { randomUUID } from 'node:crypto';

import type { CustomerDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { todayInKathmandu } from '@/app/(app)/settings/format';
import { getCustomer, listCustomers } from '@/components/p2/customers/api';
import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { SearchInput } from '@/components/ui/search-input';
import { Field } from '@/components/ui/field';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { loadEnabledCurrencies } from '@/lib/enabled-currencies.server';

import { type CustomerOption, PaymentForm } from './payment-form';
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

function Crumbs() {
  return (
    <Breadcrumb items={[{ label: 'Payments', href: '/payments' }, { label: 'Record payment' }]} />
  );
}

export default async function NewPaymentPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ customerId?: string | string[]; q?: string | string[] }>;
}) {
  const query = await searchParams;
  const rawCustomer = first(query.customerId);
  const customerId = rawCustomer !== undefined && UUID.test(rawCustomer) ? rawCustomer : '';
  const q = (first(query.q) ?? '').trim().slice(0, 100);
  const params = new URLSearchParams();
  if (customerId !== '') params.set('customerId', customerId);
  if (q !== '') params.set('q', q);
  const here = params.size > 0 ? `/payments/new?${params.toString()}` : '/payments/new';
  const session = await requireStaffSession(here);

  if (!hasPermission(session.roles, 'payment.record')) {
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

  // Never throws: a failed read gives the default list, and the API still refuses a disabled one.
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
              initialCustomerId={customers.some((c) => c.id === customerId) ? customerId : ''}
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
