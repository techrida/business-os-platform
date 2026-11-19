import { redirect } from 'next/navigation';

import { Alert } from '@/components/portal/alert';
import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { FilteredEmpty } from '@/components/portal/filtered-empty';
import { ListFilters } from '@/components/portal/list-filters';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';
import { listPortalPayments } from '@/lib/api.billing';
import { matchesSelection, matchesText } from '@/lib/list-filter';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import {
  PAYMENT_FILTER_LABELS,
  PAYMENT_FILTER_SPEC,
  PAYMENT_STATUS_OPTIONS,
} from './_components/payment-filters';
import { METHOD_LABEL } from './_components/payment-status';
import { PaymentList } from './_components/payment-list';

export const dynamic = 'force-dynamic';

const LOGIN = '/auth/login?returnTo=%2Fpayments';
const HERE = '/payments';

/**
 * The customer's own payments with their status. The API lists the session's party only, and the
 * strict list schema refuses a body with any other field (a 502, shown by the error page).
 */
export default async function PaymentsPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await getSession();
  if (!session) redirect(LOGIN);

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalPayments(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect(LOGIN);
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }
  const raw = await searchParams;
  const { submitted } = raw;
  // The API has no query parameters and returns this customer's whole list, so filter it here.
  const list = readList(raw, PAYMENT_FILTER_SPEC);
  const shown = items.filter(
    (p) =>
      matchesSelection(list.multi.status, p.status) &&
      matchesText(list.q, [p.number, p.bankReference, METHOD_LABEL[p.method]]),
  );

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your payments</h1>
        <p className={styles.lede}>
          Payments you have sent us, and where each one stands with our finance team.
        </p>
        <div>
          <LinkButton size="small" href="/payments/new">
            Submit a payment
          </LinkButton>
        </div>
      </div>
      {submitted === '1' ? (
        <Alert tone="success" role="status" className={styles.confirmation}>
          Thank you. We have your payment and proof. Our finance team will check it, and its status
          will change here from &ldquo;Awaiting verification&rdquo;.
        </Alert>
      ) : null}
      {items.length === 0 ? (
        <EmptyState
          title="No payments yet"
          icon="credit-card"
          action={<LinkButton href="/payments/new">Submit a payment</LinkButton>}
        >
          When you send us a payment, upload your bank slip here so we can match it to your invoice.
        </EmptyState>
      ) : (
        <>
          <ListFilters
            searchLabel="Search payments"
            placeholder="Search receipt, method or reference"
            filters={[
              {
                name: 'status',
                label: 'Status',
                options: PAYMENT_STATUS_OPTIONS,
                value: list.multi.status,
                allLabel: 'All statuses',
                pluralLabel: 'statuses',
              },
            ]}
            shown={shown.length}
            total={shown.length}
            noun="payment"
          />
          {shown.length === 0 ? (
            <FilteredEmpty
              noun="payments"
              labels={activeFilterLabels(list, PAYMENT_FILTER_LABELS)}
              clearHref={clearFiltersHref(HERE, raw, PAYMENT_FILTER_SPEC)}
            />
          ) : (
            <PaymentList items={shown} display={await display} />
          )}
        </>
      )}
    </main>
  );
}
