import {
  DEFAULT_ROWS,
  type MoneyTotals,
  PAYMENT_REQUEST_STATUSES,
  PaymentRequestStatusSchema,
  ROWS_OPTIONS,
  pageWindow,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import layout from '@/components/p3/list.module.css';
import { MoneyTotalRows } from '@/components/p3/money-total-rows';
import { listPaymentRequestsPage, type PaymentRequestListItem } from '@/lib/api-payables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { getGrants, hasGrant } from '@/lib/grants';
import { activeFilterLabels, clearFiltersHref, readList } from '@/lib/list-params';

import { ListPager } from '../../invoices/_components/list-pager';
import { poMoney } from '../../procurement/orders/_lib/model';
import { PAYMENT_REQUEST_COUNT_CARDS, countCards } from '../_lib/summary';
import styles from '../payables.module.css';
import { paymentRequestFailure } from './failure';
import { PAYMENT_STATUS, requestTitle } from './model';
import { PaymentRequestsFilters } from './payment-requests-filters';

export const metadata: Metadata = { title: 'Payment requests · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/payables/payment-requests';
/** ListPager offers every ROWS_OPTIONS choice, so the list accepts each one. */
const LIST = {
  multi: { status: PAYMENT_REQUEST_STATUSES },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

export default async function PaymentRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const numberSystems = await getNumberSystems();
  // Live grants (GET /v1/me), not the role defaults: an admin may grant payment requests to any role, at any scope.
  const allowed = hasGrant(await getGrants(session), 'payables.payment.request');
  const header = (
    <PageHeader
      title="Payment requests"
      description="Instructions to pay approved vendor bills. Approval does not send money."
      actions={
        allowed ? (
          <LinkButton href="/payables/payment-requests/new">New payment request</LinkButton>
        ) : null
      }
    />
  );
  if (!allowed)
    return (
      <Page>
        {header}
        <Alert tone="info" role="alert">
          Your roles do not include payment requests.
        </Alert>
      </Page>
    );
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = PaymentRequestStatusSchema.array().parse(list.multi.status);
  // The count cards: every request this person may open, whatever the filters. A failed read hides them only.
  const counts = countCards(PAYMENT_REQUEST_COUNT_CARDS, (statuses) =>
    listPaymentRequestsPage(session, { status: statuses, limit: 1, offset: 0 }).then(
      (r) => r.total,
    ),
  );
  let rows: PaymentRequestListItem[];
  let total = 0;
  let totals: MoneyTotals | null = null;
  let window = pageWindow(list.page, list.rows);
  try {
    const fetchPage = () =>
      listPaymentRequestsPage(session, {
        status,
        ...(list.q !== undefined ? { q: list.q } : {}),
        limit: window.limit,
        offset: window.offset,
      });
    let result = await fetchPage();
    // A page number past the end (a stale link) shows the last page instead of an empty table.
    const clamped = pageWindow(list.page, list.rows, result.total);
    if (result.items.length === 0 && result.total > 0 && clamped.page !== window.page) {
      window = clamped;
      result = await fetchPage();
    } else {
      window = clamped;
    }
    rows = result.items;
    total = result.total;
    totals = result.totals;
  } catch (err) {
    const f = paymentRequestFailure(err);
    return (
      <Page>
        {header}
        <Alert
          tone={f.status === 403 ? 'info' : 'error'}
          role="alert"
          title="Payment requests did not load"
        >
          {f.message}
        </Alert>
      </Page>
    );
  }
  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => PAYMENT_STATUS[v as keyof typeof PAYMENT_STATUS]?.text ?? v,
      },
    },
  );
  const cards = await counts;
  return (
    <Page>
      {header}
      {cards !== null ? (
        <section aria-label="Payment request summary" className={styles.stats}>
          {cards.map((card) => (
            <StatCard
              key={card.key}
              label={card.label}
              value={card.value}
              icon={card.icon}
              tone={card.tone}
            />
          ))}
        </section>
      ) : null}
      <PaymentRequestsFilters
        statusOptions={PAYMENT_REQUEST_STATUSES.map((value) => ({
          value,
          label: PAYMENT_STATUS[value].text,
        }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />
      {rows.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No payment requests match."
            icon="search"
            headingLevel={2}
            action={
              <LinkButton href={clearFiltersHref(PATH, params, LIST)} variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Nothing matches {filtered.join(' · ')}.
          </EmptyState>
        ) : (
          <EmptyState title="No payment requests yet." icon="banknote" headingLevel={2}>
            Create a draft for approved vendor bills.
          </EmptyState>
        )
      ) : (
        <>
          <ResultCount shown={rows.length} total={total} noun="payment request" />
          <div className={layout.results}>
            <Table
              caption="Payment requests, newest first"
              minWidth={860}
              className={styles.list ?? ''}
            >
              <thead>
                <tr>
                  <Th>Request</Th>
                  <Th>Vendor</Th>
                  <Th>Vendor bank account</Th>
                  <Th align="end">Amount</Th>
                  <Th className={styles.statusColumn}>Status</Th>
                  <Th className={styles.actionColumn}>Action</Th>
                </tr>
              </thead>
              <tbody>
                {rows.map((row) => {
                  const href = `/payables/payment-requests/${encodeURIComponent(row.id)}`;
                  const amount = poMoney(row.totalAmount, row.currency, numberSystems);
                  // Drafts share a name, so the action is named by the amount and the account too.
                  const title = requestTitle(row);
                  const name = `${title} for ${amount} to the account ending ${row.bankLast4}`;
                  const st = PAYMENT_STATUS[row.status];
                  return (
                    <tr key={row.id}>
                      <Td>
                        <Link href={href} className={styles.name}>
                          {title}
                        </Link>
                      </Td>
                      <Td>
                        {/* The row names its vendor; the link shows only when the vendor page would open. */}
                        {row.can.readVendor ? (
                          <Link
                            href={`/vendors/${encodeURIComponent(row.vendorPartyId)}`}
                            className={styles.long}
                          >
                            {row.vendorName}
                          </Link>
                        ) : (
                          <span className={styles.long}>{row.vendorName}</span>
                        )}
                      </Td>
                      <Td nowrap>Ending {row.bankLast4}</Td>
                      <Td align="end" nowrap>
                        <span className={styles.numeric}>{amount}</span>
                      </Td>
                      <Td nowrap className={styles.statusColumn}>
                        <Badge tone={st.tone}>{st.text}</Badge>
                      </Td>
                      <Td nowrap className={styles.actionColumn}>
                        <Link href={href} className={styles.rowAction} aria-label={`View ${name}`}>
                          <Icon name="chevron-right" size={20} />
                        </Link>
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
              <MoneyTotalRows
                totals={totals}
                column={3}
                columns={6}
                allPages={total > rows.length}
                format={(amount, currency) => poMoney(amount, currency, numberSystems)}
              />
            </Table>
            <ListPager
              pathname={PATH}
              current={params}
              window={window}
              total={total}
              label="Payment request pages"
            />
          </div>
        </>
      )}
    </Page>
  );
}
