import { randomUUID } from 'node:crypto';

import { pageWindow, type SalesOrderListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { listCustomers } from '@/components/p2/customers/api';
import { hasPermission } from '@/components/p2/customers/permissions';
import { listQuotations } from '@/components/p2/quotations/api';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { getSalesOrdersSummary, listSalesOrdersPage } from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import { PagedFooter } from '@/components/p3/list-view';
import layout from '@/components/p3/list.module.css';

import { ConfirmOrderDialog, type ConfirmOption } from './_components/confirm-order-dialog';
import local from './_components/sales-orders.module.css';
import { SalesOrderFilters } from './sales-order-filters';
import {
  SALES_ORDER_FILTER_OPTIONS,
  SALES_ORDER_LIST_SPEC,
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

const PATH = '/sales-orders';

export default async function SalesOrdersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const state = readList(params, SALES_ORDER_LIST_SPEC);
  const { q, rows } = state;
  const statuses = state.multi.status;
  const customerIds = state.multi.customerId;
  const filtered = q !== undefined || statuses.length > 0 || customerIds.length > 0;
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : undefined });
  const here = pageHref(state.page);
  const session = await requireStaffSession(here);
  const numberSystem = await getNumberSystem();
  const canConfirm = hasPermission(session.roles, 'sales_order.confirm');
  const filter = { status: statuses, customerId: customerIds, ...(q !== undefined ? { q } : {}) };
  const readOrders = (page: number) =>
    listSalesOrdersPage(session, { ...filter, limit: rows, offset: pageWindow(page, rows).offset });

  // The four reads do not depend on each other. Only the orders decide whether the page works:
  // without the customers the filter drops that field, without the summary the cards drop to the
  // total, without the quotations the dialog says so.
  const [orders, customers, summary, accepted] = await Promise.all([
    readOrders(state.page).then(
      (result) => ({ result, problem: null }),
      (err: unknown) => {
        const f = failureOf(err);
        return { result: null, problem: { message: f.message, status: f.status } };
      },
    ),
    listCustomers(session, { limit: CUSTOMER_OPTIONS }).then(
      (result) => result.items,
      () => null,
    ),
    getSalesOrdersSummary(session, {
      customerId: customerIds,
      ...(q !== undefined ? { q } : {}),
    }).then(
      (result) => result,
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
  const { problem } = orders;
  let result = orders.result;
  let current = pageWindow(state.page, rows, result?.total);
  // A stale link past the last page lands on the last page instead of an empty table.
  if (result !== null && current.page !== state.page && result.total > 0) {
    result = await readOrders(current.page).catch(() => result);
    current = pageWindow(current.page, rows, result?.total);
  }
  const items = result?.items ?? null;
  const total = result?.total ?? 0;

  // The chosen customers stay selectable even when they are not among the first customers read.
  const customerOptions =
    customers === null
      ? null
      : [
          ...customers.map((c) => ({ value: c.id, label: c.legalName })),
          ...customerIds
            .filter((id) => !customers.some((c) => c.id === id))
            .map((id) => ({ value: id, label: 'Selected customer' })),
        ];
  const customerName = (id: string) =>
    customerOptions?.find((option) => option.value === id)?.label ?? 'Selected customer';
  const activeFilters = activeFilterLabels(
    { q, multi: { status: statuses, customerId: customerIds }, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => SALES_ORDER_FILTER_OPTIONS.find((o) => o.value === v)?.label ?? v,
      },
      customerId: { label: 'Customer', format: customerName },
    },
  );

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
            value={total}
          />
          {summary !== null && (
            <>
              <StatCard
                label="Draft"
                icon="file-text"
                tone="neutral"
                value={summary.byStatus.draft}
              />
              <StatCard label="Confirmed" icon="list-checks" value={summary.byStatus.confirmed} />
              <StatCard
                label="Completed"
                icon="check-circle"
                tone="success"
                value={summary.byStatus.completed}
              />
            </>
          )}
        </section>
      )}

      <SalesOrderFilters
        statuses={statuses}
        customerIds={customerIds}
        statusOptions={SALES_ORDER_FILTER_OPTIONS}
        customerOptions={customerOptions}
        rows={rows}
      />

      {items !== null && <ResultCount shown={items.length} total={total} noun="sales order" />}

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
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="file-text"
            title="No matching sales orders."
            action={
              <LinkButton
                href={clearFiltersHref(PATH, params, SALES_ORDER_LIST_SPEC)}
                variant="secondary"
              >
                Clear filters
              </LinkButton>
            }
          >
            {`Nothing matches ${activeFilters.join(' · ')}.`}
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
              {items.map((item) => (
                <OrderRow numberSystem={numberSystem} key={item.id} item={item} />
              ))}
            </tbody>
          </Table>
          <PagedFooter page={current.page} pageCount={current.pageCount} href={pageHref} />
        </div>
      ) : null}
    </Page>
  );
}
