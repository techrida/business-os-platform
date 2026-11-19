import {
  type ArAgingReport,
  DEFAULT_ROWS,
  INVOICE_KINDS,
  INVOICE_STATUSES,
  type InvoiceKind,
  type InvoiceListItem,
  type InvoiceStatus,
  pageWindow,
  ROWS_OPTIONS,
  SETTLEMENT_STATUSES,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { hasPermission } from '@/components/p2/customers/permissions';
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
  getInvoicesSummary,
  type InvoicePageFilter,
  type InvoicesSummary,
  listInvoicesPage,
} from '@/lib/api-billing';
import { failureOf } from '@/lib/api-kernel';
import { getAging } from '@/lib/api-receivables';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  type RawParams,
  readList,
} from '@/lib/list-params';

import { InvoiceFilters } from './_components/invoice-filters';
import { InvoiceStatusBadge } from './_components/badges';
import styles from './_components/invoice.module.css';
import { ListPager } from './_components/list-pager';
import { recordPaymentHref, settlementMayOwe } from './_lib/gates';
import { kindMeta, settlementLabel, statusMeta } from './_lib/meta';

export const metadata: Metadata = { title: 'Invoices · Business OS' };
export const dynamic = 'force-dynamic';

function InvoiceRow({
  item,
  numberSystems,
  roles,
  mayOwe,
}: {
  item: InvoiceListItem;
  numberSystems: NumberSystems;
  roles: readonly string[];
  mayOwe: boolean;
}) {
  const kind = kindMeta(item.kind).label;
  const name = item.number ?? `${kind} (${statusMeta(item.status).label.toLowerCase()})`;
  const href = `/invoices/${encodeURIComponent(item.id)}`;
  const pay = mayOwe ? recordPaymentHref(item, roles) : null;
  return (
    <tr>
      <Th scope="row">
        <Link href={href} className={styles.number}>
          {name}
        </Link>
      </Th>
      <Td>
        <span className={styles.customer}>{item.customerName}</span>
      </Td>
      <Td nowrap>
        <Badge tone="neutral">{kind}</Badge>
      </Td>
      <Td nowrap>
        {item.issueDate !== null ? (
          <time dateTime={item.issueDate}>{when(item.issueDate, 'date')}</time>
        ) : (
          <span className={styles.quiet}>Not issued</span>
        )}
      </Td>
      <Td nowrap>
        {item.dueDate !== null ? (
          <time dateTime={item.dueDate}>{when(item.dueDate, 'date')}</time>
        ) : (
          <span className={styles.quiet}>—</span>
        )}
      </Td>
      <Td align="end" nowrap>
        <span className={styles.amount}>{money(item.total, item.currency, numberSystems)}</span>
      </Td>
      <Td nowrap>
        <InvoiceStatusBadge status={item.status} />
      </Td>
      <Td nowrap>
        <span className={styles.rowActions}>
          {pay !== null ? (
            <LinkButton
              href={pay}
              variant="secondary"
              size="small"
              aria-label={`Record payment for ${name}`}
            >
              Record payment
              <Icon name="chevron-right" size={16} />
            </LinkButton>
          ) : null}
          <Link href={href} className={styles.rowAction} aria-label={`View ${name}`}>
            <Icon name="chevron-right" size={20} />
          </Link>
        </span>
      </Td>
    </tr>
  );
}

/**
 * The count cards follow the filters; the Outstanding cards do not: they are the receivables aging totals (every
 * customer, as of today), one card per currency because amounts in different currencies are never added together.
 * Every figure is a string the server totalled; this page only formats it.
 */
function InvoiceStats({
  summary,
  outstanding,
  numberSystems,
}: {
  summary: InvoicesSummary | null;
  outstanding: ArAgingReport['totals'];
  numberSystems: NumberSystems;
}) {
  return (
    <section aria-label="Invoice summary" className={styles.stats}>
      {summary !== null ? (
        <StatCard label="Total invoices" value={summary.total} icon="receipt" />
      ) : null}
      {outstanding.map((total) => (
        <StatCard
          key={total.currency}
          label={outstanding.length > 1 ? `Outstanding · ${total.currency}` : 'Outstanding'}
          value={money(total.totalOpen, total.currency, numberSystems)}
          icon="banknote"
          tone="error"
          detail="Not yet paid, all customers"
        />
      ))}
      {summary !== null ? (
        <>
          <StatCard label="Drafts" value={summary.byStatus.draft} icon="file-text" tone="neutral" />
          <StatCard
            label="Pending approval"
            value={summary.byStatus.submitted}
            icon="inbox"
            tone="warning"
          />
          <StatCard
            label="Issued"
            value={summary.byStatus.issued}
            icon="check-circle"
            tone="success"
          />
        </>
      ) : null}
    </section>
  );
}

const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** What the URL may carry. `readList` drops anything else, and a repeated param is several values. */
const LIST = {
  multi: {
    status: INVOICE_STATUSES,
    kind: INVOICE_KINDS,
    settlement: SETTLEMENT_STATUSES,
    customerId: GUID,
  },
  single: { issuedFrom: DAY, issuedTo: DAY },
  rows: { allowed: ROWS_OPTIONS, default: DEFAULT_ROWS },
} as const;

export default async function InvoicesPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const raw = await searchParams;
  const state = readList(raw, LIST);
  const { q, rows, multi, single } = state;
  const filter: InvoicePageFilter = {
    kind: multi.kind,
    status: multi.status,
    settlement: multi.settlement,
    customerId: multi.customerId,
    issuedFrom: single.issuedFrom,
    issuedTo: single.issuedTo,
    q,
  };
  const here = hrefWith('/invoices', raw, { page: state.page > 1 ? state.page : undefined });
  const session = await requireStaffSession(here);
  const numberSystems = await getNumberSystems();

  let items: InvoiceListItem[] | null = null;
  let total = 0;
  let window = pageWindow(state.page, rows);
  let summary: InvoicesSummary | null = null;
  let problem: { message: string; status: number } | null = null;
  // The open balances behind the Outstanding cards, for the people who may read receivables. Started with the list so
  // it costs no extra wait; a failure (or no ar.read) only leaves the cards out.
  const aging: Promise<ArAgingReport | null> = hasPermission(session.roles, 'ar.read')
    ? getAging(session).catch((): null => null)
    : Promise.resolve(null);
  try {
    // The summary is the stat cards and the customer choices; a failure there hides them, not the table.
    const counts = getInvoicesSummary(session, filter).catch(() => null);
    const page = await listInvoicesPage(session, {
      ...filter,
      limit: window.limit,
      offset: window.offset,
    });
    window = pageWindow(state.page, rows, page.total);
    items = page.items;
    total = page.total;
    // A page past the end (rows changed, or rows deleted) shows the last page instead of nothing.
    if (items.length === 0 && total > 0) {
      items = (
        await listInvoicesPage(session, { ...filter, limit: window.limit, offset: window.offset })
      ).items;
    }
    summary = await counts;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const outstanding = problem === null ? ((await aging)?.totals ?? []) : [];
  const customers = summary?.customers ?? [];
  const customerName = new Map(customers.map((c) => [c.id, c.name]));
  const hiding = activeFilterLabels(
    { q, multi, single },
    {
      status: { label: 'Status', format: (v) => statusMeta(v as InvoiceStatus).label },
      kind: { label: 'Kind', format: (v) => kindMeta(v as InvoiceKind).label },
      settlement: { label: 'Payment', format: settlementLabel },
      customerId: { label: 'Customer', format: (v) => customerName.get(v) ?? 'Selected customer' },
      issuedFrom: { label: 'Issued from' },
      issuedTo: { label: 'Issued to' },
    },
    'Search',
  );
  const clearHref = clearFiltersHref('/invoices', raw, LIST);

  return (
    <Page>
      <PageHeader
        title="Invoices"
        description="Bill customers against sales orders or directly, then track payments."
        actions={
          hasPermission(session.roles, 'invoice.draft') ? (
            <LinkButton href="/invoices/new" size="large">
              <span aria-hidden="true" className={styles.addIcon}>
                +
              </span>
              Create Invoice
            </LinkButton>
          ) : null
        }
      />

      {summary !== null || outstanding.length > 0 ? (
        <InvoiceStats summary={summary} outstanding={outstanding} numberSystems={numberSystems} />
      ) : null}

      <InvoiceFilters
        status={multi.status}
        kind={multi.kind}
        settlement={multi.settlement}
        customerId={multi.customerId}
        issuedFrom={single.issuedFrom}
        issuedTo={single.issuedTo}
        customers={customers}
        preserve={{ rows: rows === DEFAULT_ROWS ? undefined : String(rows) }}
      />
      {items !== null ? <ResultCount shown={items.length} total={total} noun="invoice" /> : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include invoices'
              : 'The invoices did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the invoices</Link> : null}
        >
          {problem.status === 403
            ? 'Invoices are for the accounts and finance teams and for management. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : items === null || items.length === 0 ? (
        hiding.length > 0 ? (
          <EmptyState icon="file-text" title="No invoices match these filters.">
            Nothing matches {hiding.join('; ')}. <Link href={clearHref}>Clear filters</Link>
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No invoices yet.">
            Draft an invoice here or from a sales order’s billing schedule.
          </EmptyState>
        )
      ) : (
        <div className={styles.tableCard}>
          <Table caption="Invoices" minWidth={1080} className={styles.listTable ?? ''}>
            <thead>
              <tr>
                <Th>Invoice</Th>
                <Th>Customer</Th>
                <Th>Kind</Th>
                <Th>Issued on</Th>
                <Th>Due</Th>
                <Th align="end">Total</Th>
                <Th>Status</Th>
                <Th>Action</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <InvoiceRow
                  numberSystems={numberSystems}
                  key={item.id}
                  item={item}
                  roles={session.roles}
                  mayOwe={settlementMayOwe(multi.settlement)}
                />
              ))}
            </tbody>
          </Table>
          <ListPager
            pathname="/invoices"
            current={raw}
            window={window}
            total={total}
            label="Invoice pages"
          />
        </div>
      )}
    </Page>
  );
}
