import type { PaymentListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { hasPermission } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listPayments } from '@/lib/api-receivables';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import {
  methodLabel,
  PAYMENT_STATUS_OPTIONS,
  parseStatusFilter,
  paymentStatusMeta,
} from './_lib/status';
import styles from './payments.module.css';

export const metadata: Metadata = { title: 'Payments · Business OS' };
export const dynamic = 'force-dynamic';

function PaymentRow({ item }: { item: PaymentListItem }) {
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
        <span className={styles.amount}>{money(item.amount, item.currency)}</span>
      </Td>
      <Td align="end" nowrap>
        {Number(item.unallocatedAmount) > 0 ? (
          money(item.unallocatedAmount, item.currency)
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
  searchParams: Promise<{ status?: string | string[] }>;
}) {
  const { status: rawStatus } = await searchParams;
  const status = parseStatusFilter(rawStatus);
  const here = status === undefined ? '/payments' : `/payments?status=${status}`;
  const session = await requireStaffSession(here);

  let items: PaymentListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await listPayments(session, status);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  const hasCount = items !== null && items.length > 0;
  const mayRecord = hasPermission(session.roles, 'payment.record');

  return (
    <Page>
      <PageHeader
        title="Payments"
        description="Money customers have paid, from submitted to verified. A verified payment is allocated to invoices; only then do they count as paid."
        actions={
          hasCount || mayRecord ? (
            <>
              {items !== null && items.length > 0 ? (
                <Badge tone="info" role="status" className={styles.count}>
                  {items.length} {items.length === 1 ? 'payment' : 'payments'}
                  {status !== undefined ? ` · ${paymentStatusMeta(status).label}` : ''}
                </Badge>
              ) : null}
              {mayRecord ? <LinkButton href="/payments/new">Record payment</LinkButton> : null}
            </>
          ) : null
        }
      />

      <form method="get" action="/payments" className={styles.toolbar}>
        <div className={styles.filterField}>
          <Field label="Status">
            {(control) => (
              <Select name="status" defaultValue={status ?? ''} {...control}>
                <option value="">All statuses</option>
                {PAYMENT_STATUS_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        <div className={styles.toolbarActions}>
          <Button type="submit" variant="secondary">
            Apply filter
          </Button>
          {status !== undefined ? <Link href="/payments">Show all payments</Link> : null}
        </div>
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
      ) : items !== null && items.length === 0 ? (
        status !== undefined ? (
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
            {items.map((item) => (
              <PaymentRow key={item.id} item={item} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </Page>
  );
}
