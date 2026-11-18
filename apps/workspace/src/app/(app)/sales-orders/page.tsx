import { randomUUID } from 'node:crypto';

import type { SalesOrderListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCustomers } from '@/components/p2/customers/api';
import { hasPermission } from '@/components/p2/customers/permissions';
import { listQuotations } from '@/components/p2/quotations/api';
import styles from '@/components/p2/quotations/list.module.css';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Field, Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listSalesOrders } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { ConfirmOrderDialog, type ConfirmOption } from './_components/confirm-order-dialog';
import local from './_components/sales-orders.module.css';
import {
  parseCustomerFilter,
  parseOrderStatusFilter,
  SALES_ORDER_FILTER_OPTIONS,
  salesOrderStatusMeta,
} from './_lib/status';

export const metadata: Metadata = { title: 'Sales orders · Business OS' };
export const dynamic = 'force-dynamic';

/** How many customers the filter offers. A longer list needs a search box, which is not built yet. */
const CUSTOMER_OPTIONS = 100;

function OrderRow({ item }: { item: SalesOrderListItem }) {
  const { label, tone } = salesOrderStatusMeta(item.status);
  return (
    <tr>
      <Td nowrap>
        <Link href={`/sales-orders/${encodeURIComponent(item.id)}`} className={styles.number}>
          {item.number ?? 'Draft order'}
        </Link>
      </Td>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <Badge tone={tone}>{label}</Badge>
      </Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.total, item.currency)}</span>
      </Td>
      <Td nowrap>
        {item.confirmedAt !== null ? (
          <time dateTime={item.confirmedAt}>{when(item.confirmedAt, 'date')}</time>
        ) : (
          <span className={local.quiet}>Not confirmed yet</span>
        )}
      </Td>
    </tr>
  );
}

function hrefWith(status: string | undefined, customerId: string | undefined): string {
  const query = new URLSearchParams();
  if (status !== undefined) query.set('status', status);
  if (customerId !== undefined) query.set('customerId', customerId);
  const text = query.toString();
  return text === '' ? '/sales-orders' : `/sales-orders?${text}`;
}

export default async function SalesOrdersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ status?: string | string[]; customerId?: string | string[] }>;
}) {
  const raw = await searchParams;
  const status = parseOrderStatusFilter(raw.status);
  const customerId = parseCustomerFilter(raw.customerId);
  const here = hrefWith(status, customerId);
  const session = await requireStaffSession(here);
  const canConfirm = hasPermission(session.roles, 'sales_order.confirm');

  // The three reads do not depend on each other. Only the orders decide whether the page works:
  // without the customers the filter drops that field, without the quotations the dialog says so.
  const [orders, customers, accepted] = await Promise.all([
    listSalesOrders(session, { status, customerId }).then(
      (items) => ({ items, problem: null }),
      (err: unknown) => {
        const f = failureOf(err);
        return { items: null, problem: { message: f.message, status: f.status } };
      },
    ),
    listCustomers(session, { limit: CUSTOMER_OPTIONS }).then(
      (result) => result.items,
      () => null,
    ),
    canConfirm
      ? listQuotations(session, { status: 'accepted' }).then(
          (items): ConfirmOption[] =>
            items.map((q) => ({
              versionId: q.currentVersionId,
              label: `${q.number} · ${q.customerName} · ${money(q.total, q.currency)}`,
            })),
          () => null,
        )
      : Promise.resolve(undefined),
  ]);
  const { items, problem } = orders;
  const filtered = status !== undefined || customerId !== undefined;

  // The chosen customer stays selectable even when it is not among the first customers read.
  const customerOptions =
    customers === null
      ? null
      : [
          ...customers.map((c) => ({ id: c.id, name: c.legalName })),
          ...(customerId !== undefined && !customers.some((c) => c.id === customerId)
            ? [{ id: customerId, name: 'Selected customer' }]
            : []),
        ];

  return (
    <Page>
      <PageHeader
        title="Sales orders"
        description="Every confirmed sale with its customer, status and total. Open one to see its billing schedule."
        actions={
          <>
            {items !== null && items.length > 0 ? (
              <Badge tone="info" role="status" className={styles.count ?? ''}>
                {items.length} {items.length === 1 ? 'sales order' : 'sales orders'}
                {status !== undefined ? ` · ${salesOrderStatusMeta(status).label}` : ''}
              </Badge>
            ) : null}
            {accepted !== undefined ? (
              <ConfirmOrderDialog
                options={accepted}
                idempotencyKey={randomUUID()}
                reloadHref={here}
              />
            ) : null}
          </>
        }
      />

      <form method="get" action="/sales-orders" className={styles.toolbar}>
        <div className={styles.filterField}>
          <Field label="Status">
            {(control) => (
              <Select name="status" defaultValue={status ?? ''} {...control}>
                <option value="">All statuses</option>
                {SALES_ORDER_FILTER_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        </div>
        {customerOptions !== null ? (
          <div className={styles.filterField}>
            <Field label="Customer">
              {(control) => (
                <Select name="customerId" defaultValue={customerId ?? ''} {...control}>
                  <option value="">All customers</option>
                  {customerOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.name}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        ) : null}
        <div className={styles.toolbarActions}>
          <Button type="submit" variant="secondary">
            Apply filter
          </Button>
          {filtered ? <Link href="/sales-orders">Show all sales orders</Link> : null}
        </div>
      </form>

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include sales orders'
              : 'The sales orders did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the sales orders</Link> : null}
        >
          {problem.status === 403
            ? 'Sales orders are for Accounts, Finance and the people who oversee them. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="file-text"
            title={
              status !== undefined
                ? `No sales orders are ${salesOrderStatusMeta(status).label.toLowerCase()}.`
                : 'No sales orders for this customer.'
            }
          >
            Choose another filter, or show all sales orders.
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No sales orders yet.">
            A sales order is confirmed from an accepted quotation. It appears here once it exists.
          </EmptyState>
        )
      ) : items !== null ? (
        <Table caption="Sales orders" minWidth={720}>
          <thead>
            <tr>
              <Th>Order</Th>
              <Th>Customer</Th>
              <Th>Status</Th>
              <Th align="end">Total</Th>
              <Th>Confirmed on</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <OrderRow key={item.id} item={item} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </Page>
  );
}
