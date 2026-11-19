import { randomUUID } from 'node:crypto';

import type { SalesOrderListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { listCustomers } from '@/components/p2/customers/api';
import { hasPermission } from '@/components/p2/customers/permissions';
import { listQuotations } from '@/components/p2/quotations/api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listSalesOrders } from '@/lib/api-billing';
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

function OrderRow({
  item,
  numberSystem,
}: {
  item: SalesOrderListItem;
  numberSystem: NumberSystem;
}) {
  const { label, tone } = salesOrderStatusMeta(item.status);
  return (
    <tr>
      <Td nowrap>
        <Link href={`/sales-orders/${encodeURIComponent(item.id)}`} className={layout.number}>
          {item.number ?? 'Draft order'}
        </Link>
      </Td>
      <Td>
        <span className={layout.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <Badge tone={tone}>{label}</Badge>
      </Td>
      <Td align="end" nowrap>
        <span className={layout.amount}>{money(item.total, item.currency, numberSystem)}</span>
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

export default async function SalesOrdersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<ListQuery & { status?: string | string[]; customerId?: string | string[] }>;
}) {
  const raw = await searchParams;
  const status = parseOrderStatusFilter(raw.status);
  const customerId = parseCustomerFilter(raw.customerId);
  const { q, page } = listQuery(raw);
  const filters = { status, customerId, q };
  const here = listHref('/sales-orders', filters, page);
  const session = await requireStaffSession(here);
  const numberSystem = await getNumberSystem();
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
              label: `${q.number} · ${q.customerName} · ${money(q.total, q.currency, numberSystem)}`,
            })),
          () => null,
        )
      : Promise.resolve(undefined),
  ]);
  const { items, problem } = orders;
  const filtered = status !== undefined || customerId !== undefined || q !== '';
  const needle = q.toLowerCase();
  const matches = (items ?? []).filter((order) =>
    [order.number ?? 'Draft order', order.customerName].some((text) =>
      text.toLowerCase().includes(needle),
    ),
  );
  const window = listWindow(matches, page);

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
        description="Track confirmed sales and their billing schedules."
        actions={
          accepted !== undefined ? (
            <ConfirmOrderDialog
              options={accepted}
              idempotencyKey={randomUUID()}
              reloadHref={here}
            />
          ) : null
        }
      />

      {items !== null && (
        <section aria-label="Sales order summary" className={layout.stats}>
          <StatCard
            label={filtered ? 'Matching orders' : 'Total orders'}
            icon="receipt"
            value={matches.length}
          />
          <StatCard
            label="Draft"
            icon="file-text"
            tone="neutral"
            value={matches.filter((item) => item.status === 'draft').length}
          />
          <StatCard
            label="Confirmed"
            icon="list-checks"
            value={matches.filter((item) => item.status === 'confirmed').length}
          />
          <StatCard
            label="Completed"
            icon="check-circle"
            tone="success"
            value={matches.filter((item) => item.status === 'completed').length}
          />
        </section>
      )}

      <form method="get" action="/sales-orders" className={layout.toolbar}>
        <SearchInput
          name="q"
          aria-label="Search sales orders"
          placeholder="Search orders or customers"
          defaultValue={q}
          maxLength={100}
          wrapperClassName={layout.search}
        />
        <label className="sr-only" htmlFor="order-status">
          Status
        </label>
        <Select
          id="order-status"
          name="status"
          className={layout.select}
          defaultValue={status ?? ''}
        >
          <option value="">All statuses</option>
          {SALES_ORDER_FILTER_OPTIONS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </Select>
        {customerOptions !== null ? (
          <>
            <label className="sr-only" htmlFor="order-customer">
              Customer
            </label>
            <Select
              id="order-customer"
              name="customerId"
              className={layout.select}
              defaultValue={customerId ?? ''}
            >
              <option value="">All customers</option>
              {customerOptions.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.name}
                </option>
              ))}
            </Select>
          </>
        ) : null}
        <Button type="submit" variant="secondary">
          Apply filter
        </Button>
        {filtered ? <Link href="/sales-orders">Show all sales orders</Link> : null}
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
            ? 'Ask an administrator if you need access to sales orders.'
            : problem.message}
        </Alert>
      ) : items !== null && matches.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="file-text"
            title={
              q
                ? 'No matching sales orders.'
                : status !== undefined
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
        <div className={layout.results}>
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
              {window.rows.map((item) => (
                <OrderRow numberSystem={numberSystem} key={item.id} item={item} />
              ))}
            </tbody>
          </Table>
          <ListFooter
            count={matches.length}
            noun="sales order"
            path="/sales-orders"
            filters={filters}
            window={window}
          />
        </div>
      ) : null}
    </Page>
  );
}
