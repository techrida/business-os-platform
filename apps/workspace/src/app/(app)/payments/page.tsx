import type { PaymentListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listPayments } from '@/lib/api-receivables';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import {
  ListFooter,
  listHref,
  listQuery,
  listWindow,
  type ListQuery,
} from '@/components/p3/list-view';
import layout from '@/components/p3/list.module.css';

import {
  methodLabel,
  PAYMENT_STATUS_OPTIONS,
  parseStatusFilter,
  paymentStatusMeta,
} from './_lib/status';
import styles from './payments.module.css';

export const metadata: Metadata = { title: 'Payments · Business OS' };
export const dynamic = 'force-dynamic';

function PaymentRow({ item, numberSystem }: { item: PaymentListItem; numberSystem: NumberSystem }) {
  const meta = paymentStatusMeta(item.status);
  return (
    <tr>
      <Td nowrap>
        <Link href={`/payments/${encodeURIComponent(item.id)}`} className={styles.number}>
          {item.number ?? 'Not yet numbered'}
        </Link>
      </Td>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <Badge tone={meta.tone}>{meta.label}</Badge>
      </Td>
      <Td>{methodLabel(item.method)}</Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.amount, item.currency, numberSystem)}</span>
      </Td>
      <Td align="end" nowrap>
        {Number(item.unallocatedAmount) > 0 ? (
          money(item.unallocatedAmount, item.currency, numberSystem)
        ) : (
          <span className={styles.quiet}>None</span>
        )}
      </Td>
      <Td nowrap>
        <time dateTime={item.receivedOn}>{when(item.receivedOn, 'date')}</time>
      </Td>
    </tr>
  );
}

export default async function PaymentsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<ListQuery & { status?: string | string[] }>;
}) {
  const raw = await searchParams;
  const status = parseStatusFilter(raw.status);
  const { q, page } = listQuery(raw);
  const filters = { status, q };
  const here = listHref('/payments', filters, page);
  const session = await requireStaffSession(here);
  const numberSystem = await getNumberSystem();

  let items: PaymentListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listPayments(session, status);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  const needle = q.toLowerCase();
  const matches = (items ?? []).filter((payment) =>
    [payment.number ?? 'Not yet numbered', payment.customerName, methodLabel(payment.method)].some(
      (text) => text.toLowerCase().includes(needle),
    ),
  );
  const window = listWindow(matches, page);
  const mayRecord = hasPermission(session.roles, 'payment.record');

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

      {items !== null && (
        <section aria-label="Payment summary" className={layout.stats}>
          <StatCard
            label={status || q ? 'Matching payments' : 'Total payments'}
            icon="banknote"
            value={matches.length}
          />
          <StatCard
            label="Awaiting verification"
            icon="list-checks"
            tone="warning"
            value={matches.filter((item) => item.status === 'submitted').length}
          />
          <StatCard
            label="Verified"
            icon="check-circle"
            tone="success"
            value={matches.filter((item) => item.status === 'verified').length}
          />
          <StatCard
            label="Rejected"
            icon="x-circle"
            tone="error"
            value={matches.filter((item) => item.status === 'rejected').length}
          />
        </section>
      )}
      <form method="get" action="/payments" className={layout.toolbar}>
        <SearchInput
          name="q"
          aria-label="Search payments"
          placeholder="Search receipts or customers"
          defaultValue={q}
          maxLength={100}
          wrapperClassName={layout.search}
        />
        <label className="sr-only" htmlFor="payment-status">
          Status
        </label>
        <Select
          id="payment-status"
          className={layout.select}
          name="status"
          defaultValue={status ?? ''}
        >
          <option value="">All statuses</option>
          {PAYMENT_STATUS_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        <Button type="submit" variant="secondary">
          Apply filter
        </Button>
        {status !== undefined || q ? <Link href="/payments">Show all payments</Link> : null}
      </form>

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
      ) : items !== null && matches.length === 0 ? (
        q ? (
          <EmptyState icon="search" title="No matching payments.">
            Try another receipt number or customer name.
          </EmptyState>
        ) : status !== undefined ? (
          <EmptyState
            icon="banknote"
            title={`No payments are ${paymentStatusMeta(status).label.toLowerCase()}.`}
          >
            Choose another status, or show all payments.
          </EmptyState>
        ) : (
          <EmptyState icon="banknote" title="No payments yet.">
            A payment appears here when a customer uploads proof in the portal or when you record
            one.
          </EmptyState>
        )
      ) : items !== null ? (
        <div className={layout.results}>
          <Table caption="Payments" minWidth={860}>
            <thead>
              <tr>
                <Th>Receipt</Th>
                <Th>Customer</Th>
                <Th>Status</Th>
                <Th>Method</Th>
                <Th align="end">Amount received</Th>
                <Th align="end">Not yet allocated</Th>
                <Th>Received on</Th>
              </tr>
            </thead>
            <tbody>
              {window.rows.map((item) => (
                <PaymentRow numberSystem={numberSystem} key={item.id} item={item} />
              ))}
            </tbody>
          </Table>
          <ListFooter
            count={matches.length}
            noun="payment"
            path="/payments"
            filters={filters}
            window={window}
          />
        </div>
      ) : null}
    </Page>
  );
}
