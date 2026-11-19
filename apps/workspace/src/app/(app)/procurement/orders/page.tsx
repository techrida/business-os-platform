import { PO_STATUSES, PoStatusSchema, pageWindow } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';

import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getVendor } from '@/lib/api-vendors';
import { listPurchaseOrdersPage, type PoListItem } from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';
import type { Session } from '@/lib/session';

import layout from '../procurement.module.css';
import { poFailure } from './_lib/failure';
import { PO_STATUS_LABEL, poMoney } from './_lib/model';
import styles from './orders.module.css';
import { OrdersFilters } from './orders-filters';

export const metadata: Metadata = { title: 'Purchase orders · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/procurement/orders';
const LIST = { multi: { status: PO_STATUSES } } as const;

/** Vendor names for the rows on this page. Unreadable vendors show an explicit unavailable-name label. */
async function vendorNames(session: Session, ids: readonly string[]): Promise<Map<string, string>> {
  const unique = [...new Set(ids)];
  const settled = await Promise.allSettled(unique.map((id) => getVendor(session, id)));
  const names = new Map<string, string>();
  settled.forEach((r, i) => {
    const id = unique[i];
    if (id !== undefined && r.status === 'fulfilled') names.set(id, r.value.legalName);
  });
  return names;
}

function Row({
  po,
  vendor,
  numberSystem,
}: {
  po: PoListItem;
  vendor: string | undefined;
  numberSystem: NumberSystem;
}) {
  const status = PO_STATUS_LABEL[po.status];
  return (
    <tr>
      <Td>
        <Link href={`/procurement/orders/${encodeURIComponent(po.id)}`} className={styles.name}>
          {po.number}
        </Link>
      </Td>
      <Td>
        <CellTitle
          title={
            vendor !== undefined ? (
              <span className={styles.long}>{vendor}</span>
            ) : (
              <span className={styles.quiet}>Vendor name unavailable</span>
            )
          }
        />
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {poMoney(po.approvedTotal, po.currency, numberSystem)}
        </span>
      </Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>v{po.currentVersion}</span>
      </Td>
      <Td nowrap>
        {po.issuedAt !== null ? (
          <time dateTime={po.issuedAt}>{when(po.issuedAt, 'date')}</time>
        ) : (
          <span className={styles.quiet}>Not issued</span>
        )}
      </Td>
    </tr>
  );
}

export default async function PurchaseOrdersPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const numberSystem = await getNumberSystem();
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = PoStatusSchema.array().parse(list.multi.status);

  let orders: PoListItem[] | null = null;
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  let problem: { message: string; status: number } | null = null;
  try {
    const fetchPage = () =>
      listPurchaseOrdersPage(session, {
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
    orders = result.items;
    total = result.total;
  } catch (err) {
    const f = poFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const names =
    orders !== null && orders.length > 0
      ? await vendorNames(
          session,
          orders.map((o) => o.vendorId),
        )
      : new Map<string, string>();
  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => PO_STATUS_LABEL[v as keyof typeof PO_STATUS_LABEL]?.text ?? v,
      },
    },
  );
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : null });
  const nearby = Array.from({ length: window.pageCount }, (_, i) => i + 1).filter(
    (n) => Math.abs(n - window.page) <= 2,
  );

  return (
    <Page className={layout.list}>
      <PageHeader
        title="Purchase orders"
        description="Orders placed with approved vendors. An order is issued once, and every change after that is a new version."
      />

      <OrdersFilters
        statusOptions={PO_STATUSES.map((s) => ({ value: s, label: PO_STATUS_LABEL[s].text }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include purchase orders'
              : 'Purchase orders did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={hrefWith(PATH, params, {})}>Reload purchase orders</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Purchase orders are for the procurement team. Ask an administrator if you need access. To receive goods, open the receipts screen.'
            : problem.message}
        </Alert>
      ) : orders !== null && orders.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No purchase orders match."
            icon="search"
            action={
              <LinkButton href={clearFiltersHref(PATH, params, LIST)} variant="secondary">
                Clear filters
              </LinkButton>
            }
          >
            Nothing matches {filtered.join(' · ')}.
          </EmptyState>
        ) : (
          <EmptyState title="No purchase orders yet." icon="file-text">
            An order is drafted when a purchase request has an approved quotation. It appears here,
            ready to issue.
          </EmptyState>
        )
      ) : orders !== null ? (
        <div className={layout.results}>
          <ResultCount shown={orders.length} total={total} noun="purchase order" />
          <Table className={layout.resultsTable ?? ''} caption="Purchase orders" minWidth={760}>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Vendor</Th>
                <Th>Status</Th>
                <Th align="end">Approved total</Th>
                <Th align="end">Version</Th>
                <Th>Issued</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <Row
                  numberSystem={numberSystem}
                  key={po.id}
                  po={po}
                  vendor={names.get(po.vendorId)}
                />
              ))}
            </tbody>
          </Table>
          <Pagination
            label="Pages"
            summary={`Showing ${window.first}-${window.last} of ${total}`}
            {...(window.page > 1 ? { previousHref: pageHref(window.page - 1) } : {})}
            {...(window.page < window.pageCount ? { nextHref: pageHref(window.page + 1) } : {})}
            pages={nearby.map((n) => ({ page: n, href: pageHref(n) }))}
            currentPage={window.page}
          />
        </div>
      ) : null}
    </Page>
  );
}
