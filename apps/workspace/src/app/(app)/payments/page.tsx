import {
  DEFAULT_ROWS,
  PAYMENT_METHODS,
  PAYMENT_STATUSES,
  type MoneyTotals,
  type PaymentListItem,
  type PaymentStatus,
  pageWindow,
  ROWS_OPTIONS,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import {
  getPaymentsSummary,
  listPaymentsPage,
  type PaymentPageFilter,
  type PaymentsSummary,
} from '@/lib/api-receivables';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { MoneyTotalRows } from '@/components/p3/money-total-rows';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  type RawParams,
  readList,
} from '@/lib/list-params';
import { getGrants, hasGrant } from '@/lib/grants';

import { ListPager } from '../invoices/_components/list-pager';
import layout from '@/components/p3/list.module.css';

import { PaymentFilters } from './_components/payment-filters';
import { methodLabel, paymentStatusMeta } from './_lib/status';
import styles from './payments.module.css';

export const metadata: Metadata = { title: 'Payments · Business OS' };
export const dynamic = 'force-dynamic';

function PaymentRow({
  item,
  numberSystems,
}: {
  item: PaymentListItem;
  numberSystems: NumberSystems;
}) {
  const meta = paymentStatusMeta(item.status);
  const href = `/payments/${encodeURIComponent(item.id)}`;
  // An unnumbered payment is named by who paid and when, so each row's action reads differently.
  const name =
    item.number ??
    `payment of ${money(item.amount, item.currency, numberSystems)} from ${item.customerName} received ${when(item.receivedOn, 'date')}`;
  return (
    <tr>
      <Td nowrap>
        <Link href={href} className={styles.number}>
          {item.number ?? 'Not yet numbered'}
        </Link>
      </Td>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td>{methodLabel(item.method)}</Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.amount, item.currency, numberSystems)}</span>
      </Td>
      <Td align="end" nowrap>
        {Number(item.unallocatedAmount) > 0 ? (
          money(item.unallocatedAmount, item.currency, numberSystems)
        ) : (
          <span className={styles.quiet}>None</span>
        )}
      </Td>
      <Td nowrap>
        <time dateTime={item.receivedOn}>{when(item.receivedOn, 'date')}</time>
      </Td>
      <Td nowrap pinned>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </Td>
      <Td nowrap pinned>
        <Link href={href} className={styles.rowAction} aria-label={`View ${name}`}>
          <Icon name="chevron-right" size={20} />
        </Link>
      </Td>
    </tr>
  );
}

/** What the URL may carry. `readList` drops anything else, and a repeated param is several values. */
const LIST = {
  multi: { status: PAYMENT_STATUSES, method: PAYMENT_METHODS },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

export default async function PaymentsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<RawParams>;
}) {
  const raw = await searchParams;
  const state = readList(raw, LIST);
  const { q, rows, multi } = state;
  const filter: PaymentPageFilter = { status: multi.status, method: multi.method, q };
  const here = hrefWith('/payments', raw, { page: state.page > 1 ? state.page : undefined });
  const session = await requireStaffSession(here);
  const numberSystems = await getNumberSystems();

  let items: PaymentListItem[] | null = null;
  let total = 0;
  let totals: MoneyTotals | null = null;
  let window = pageWindow(state.page, rows);
  let summary: PaymentsSummary | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    // The summary is the stat cards; a failure there hides them, not the table.
    const counts = getPaymentsSummary(session, filter).catch(() => null);
    const page = await listPaymentsPage(session, {
      ...filter,
      limit: window.limit,
      offset: window.offset,
    });
    window = pageWindow(state.page, rows, page.total);
    items = page.items;
    total = page.total;
    totals = page.totals;
    // A page past the end (rows changed) shows the last page instead of nothing.
    if (items.length === 0 && total > 0) {
      items = (
        await listPaymentsPage(session, { ...filter, limit: window.limit, offset: window.offset })
      ).items;
    }
    summary = await counts;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const mayRecord = hasGrant(await getGrants(session), 'payment.record');
  const hiding = activeFilterLabels(
    { q, multi, single: {} },
    {
      status: { label: 'Status', format: (v) => paymentStatusMeta(v as PaymentStatus).label },
      method: { label: 'Method', format: methodLabel },
    },
    'Search',
  );
  const clearHref = clearFiltersHref('/payments', raw, LIST);

  return (
    <Page>
      <PageHeader
        title="Payments"
        description="Review customer payments and allocate verified receipts to invoices."
        actions={
          mayRecord ? (
            <LinkButton href="/payments/new">
              <span aria-hidden="true">＋</span> Record payment
            </LinkButton>
          ) : null
        }
      />

      {summary !== null && (
        <section aria-label="Payment summary" className={layout.stats}>
          <StatCard
            label={hiding.length > 0 ? 'Matching payments' : 'Total payments'}
            icon="banknote"
            value={summary.total}
          />
          <StatCard
            label="Awaiting verification"
            icon="list-checks"
            tone="warning"
            value={summary.byStatus.submitted}
          />
          <StatCard
            label="Verified"
            icon="check-circle"
            tone="success"
            value={summary.byStatus.verified}
          />
          <StatCard
            label="Rejected"
            icon="x-circle"
            tone="error"
            value={summary.byStatus.rejected}
          />
        </section>
      )}
      <PaymentFilters
        status={multi.status}
        method={multi.method}
        preserve={{ rows: rows === DEFAULT_ROWS ? undefined : String(rows) }}
      />
      {items !== null ? <ResultCount shown={items.length} total={total} noun="payment" /> : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include payments'
              : 'The payments did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the payments</Link> : null}
        >
          {problem.status === 403
            ? 'Payments are for the accounts and finance team. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : items !== null && items.length === 0 ? (
        hiding.length > 0 ? (
          <EmptyState icon="search" title="No payments match these filters.">
            Nothing matches {hiding.join('; ')}. <Link href={clearHref}>Clear filters</Link>
          </EmptyState>
        ) : (
          <EmptyState icon="banknote" title="No payments yet.">
            A payment appears here when a customer uploads proof in the portal or when you record
            one.
          </EmptyState>
        )
      ) : items !== null ? (
        <div className={layout.results}>
          <Table caption="Payments" minWidth={960}>
            <thead>
              <tr>
                <Th>Receipt</Th>
                <Th>Customer</Th>
                <Th>Method</Th>
                <Th align="end">Amount received</Th>
                <Th align="end">Not yet allocated</Th>
                <Th>Received on</Th>
                <Th pinned>Status</Th>
                <Th pinned>Action</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <PaymentRow numberSystems={numberSystems} key={item.id} item={item} />
              ))}
            </tbody>
            <MoneyTotalRows
              totals={totals}
              column={3}
              columns={8}
              allPages={total > items.length}
              format={(amount, currency) => money(amount, currency, numberSystems)}
            />
          </Table>
          <ListPager
            pathname="/payments"
            current={raw}
            window={window}
            total={total}
            label="Payment pages"
          />
        </div>
      ) : null}
    </Page>
  );
}
