import {
  DEFAULT_ROWS,
  PO_STATUSES,
  PoStatusSchema,
  ROWS_OPTIONS,
  pageWindow,
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
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listPurchaseOrdersPage, type PoListItem } from '@/lib/api-purchase-orders';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import listLayout from '@/components/p3/list.module.css';

import { ListPager } from '../../invoices/_components/list-pager';
import layout from '../procurement.module.css';
import { PO_SUMMARY, summaryCards } from '../rfqs/_lib/summary';
import { poFailure } from './_lib/failure';
import { PO_STATUS_LABEL, poMoney } from './_lib/model';
import styles from './orders.module.css';
import { OrdersFilters } from './orders-filters';

export const metadata: Metadata = { title: 'Purchase orders · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/procurement/orders';
const LIST = {
  multi: { status: PO_STATUSES },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

function Row({ po, numberSystems }: { po: PoListItem; numberSystems: NumberSystems }) {
  const status = PO_STATUS_LABEL[po.status];
  const href = `/procurement/orders/${encodeURIComponent(po.id)}`;
  return (
    <tr>
      <Td>
        <Link href={href} className={styles.name}>
          {po.number}
        </Link>
      </Td>
      <Td>
        <CellTitle title={<span className={styles.long}>{po.vendorName}</span>} />
      </Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {poMoney(po.approvedTotal, po.currency, numberSystems)}
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
      <Td nowrap pinned>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td nowrap pinned>
        <Link href={href} className={styles.rowAction} aria-label={`View ${po.number}`}>
          <Icon name="chevron-right" size={20} />
        </Link>
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
  const numberSystems = await getNumberSystems();
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = PoStatusSchema.array().parse(list.multi.status);

  let orders: PoListItem[] | null = null;
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  let problem: { message: string; status: number } | null = null;
  // Started before the table's read; a failure here hides the cards, not the table.
  const summary = summaryCards(PO_SUMMARY, (s) =>
    listPurchaseOrdersPage(session, { status: s, limit: 1, offset: 0 }),
  );
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

  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => PO_STATUS_LABEL[v as keyof typeof PO_STATUS_LABEL]?.text ?? v,
      },
    },
  );
  const cards = await summary;

  return (
    <Page className={layout.list}>
      <PageHeader
        title="Purchase orders"
        description="Orders placed with approved vendors. An order is issued once, and every change after that is a new version."
      />

      {problem === null && cards !== null ? (
        <section aria-label="Purchase order summary" className={listLayout.stats}>
          {cards.map((card) => (
            <StatCard
              key={card.key}
              label={card.label}
              icon={card.icon}
              tone={card.tone}
              value={card.value}
            />
          ))}
        </section>
      ) : null}

      <OrdersFilters
        statusOptions={PO_STATUSES.map((s) => ({ value: s, label: PO_STATUS_LABEL[s].text }))}
        status={status}
        rows={list.rows === DEFAULT_ROWS ? undefined : String(list.rows)}
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
            ? 'Purchase orders are for procurement, accounts, finance and the warehouse. Ask an administrator if you need access.'
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
          <Table className={layout.resultsTable ?? ''} caption="Purchase orders" minWidth={860}>
            <thead>
              <tr>
                <Th>Number</Th>
                <Th>Vendor</Th>
                <Th align="end">Approved total</Th>
                <Th align="end">Version</Th>
                <Th>Issued</Th>
                <Th pinned>Status</Th>
                <Th pinned>Action</Th>
              </tr>
            </thead>
            <tbody>
              {orders.map((po) => (
                <Row numberSystems={numberSystems} key={po.id} po={po} />
              ))}
            </tbody>
          </Table>
          <ListPager
            pathname={PATH}
            current={params}
            window={window}
            total={total}
            label="Purchase order pages"
          />
        </div>
      ) : null}
    </Page>
  );
}
