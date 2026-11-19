import {
  pageWindow,
  type QuotationListItem,
  type QuotationStatus,
  type QuotationSummary,
} from '@bos/contracts';
import type { NumberSystems } from '@bos/locale';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listCustomers } from '@/components/p2/customers/api';
import {
  getQuotationsSummary,
  listQuotationsPage,
  type QuotationListFilter,
} from '@/components/p2/quotations/api';
import styles from '@/components/p2/quotations/list.module.css';
import {
  QUOTATION_DEFAULT_ROWS,
  QUOTATION_FILTER_SPEC,
  QUOTATION_LIST_SPEC,
  QUOTATION_ROW_OPTIONS,
  STATUS_FILTER_OPTIONS,
} from '@/components/p2/quotations/status';
import { editQuotationHref, newQuotationHref } from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { statusWorth } from '@/components/p2/quotations/summary-amount';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import { QuotationFilters } from './quotation-filters';

export const metadata: Metadata = { title: 'Quotations · Business OS' };
export const dynamic = 'force-dynamic';

/** How many customers the filter offers. A longer list needs a search box, which is not built yet. */
const CUSTOMER_OPTIONS = 100;

const PATH = '/quotations';

function QuotationRow({
  item,
  numberSystems,
}: {
  item: QuotationListItem;
  numberSystems: NumberSystems;
}) {
  const href = `/quotations/${encodeURIComponent(item.id)}`;
  return (
    <tr>
      <Td>
        <Link href={href} className={styles.number}>
          {item.number}
        </Link>
        <span className={styles.amount}>{money(item.total, item.currency, numberSystems)}</span>
      </Td>
      <Td className={styles.customer}>{item.customerName}</Td>
      <Td>
        {item.ownerName !== null ? (
          <span className={styles.owner}>
            <Avatar name={item.ownerName} shape="circle" size="small" />
            {item.ownerName}
          </span>
        ) : (
          <span className={styles.quiet}>Unassigned</span>
        )}
      </Td>
      <Td nowrap className={styles.statusColumn}>
        <QuotationStatusBadge status={item.status} />
      </Td>
      <Td nowrap className={styles.actionColumn}>
        <time dateTime={item.validUntil}>{when(item.validUntil, 'date')}</time>
      </Td>
      <Td className={styles.actionColumn}>
        {item.canEdit ? (
          <LinkButton
            size="small"
            variant="secondary"
            href={editQuotationHref(item.id)}
            aria-label={`Edit ${item.number}`}
          >
            Edit
          </LinkButton>
        ) : (
          <LinkButton
            size="small"
            variant="secondary"
            href={href}
            aria-label={`View ${item.number}`}
          >
            View
          </LinkButton>
        )}
      </Td>
    </tr>
  );
}

function QuotationStats({
  summary,
  filtered,
  numberSystems,
}: {
  summary: QuotationSummary;
  filtered: boolean;
  numberSystems: NumberSystems;
}) {
  const { byStatus } = summary;
  // The worth appears only as one real figure in one currency; mixed currencies leave the count alone.
  const worth = (status: QuotationStatus, caption: string) => {
    const amount = statusWorth(summary, status);
    return amount === null
      ? undefined
      : `${money(amount.total, amount.currency, numberSystems)} ${caption}`;
  };
  return (
    <section className={styles.stats} aria-label="Quotation totals by status">
      <StatCard
        label={filtered ? 'Matching quotations' : 'Total quotations'}
        value={summary.total}
        icon="file-text"
      />
      <StatCard
        label="Internal approval"
        value={byStatus.submitted}
        icon="shield-check"
        tone="warning"
        detail={worth('submitted', 'requiring approval')}
      />
      <StatCard
        label="In customer review"
        value={byStatus.sent}
        icon="users"
        detail={worth('sent', 'outstanding')}
      />
      <StatCard
        label="Accepted"
        value={byStatus.accepted}
        icon="check-circle"
        tone="success"
        detail={worth('accepted', 'contracted')}
      />
    </section>
  );
}

export default async function QuotationsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const state = readList(params, QUOTATION_LIST_SPEC);
  const { q, rows } = state;
  const statuses = state.multi.status;
  const customerIds = state.multi.customerId;
  const opportunityId = state.single.opportunityId;
  const filtered = q !== undefined || statuses.length > 0 || customerIds.length > 0;
  const pageHref = (page: number) => hrefWith(PATH, params, { page: page > 1 ? page : undefined });
  const here = pageHref(state.page);
  const session = await requireStaffSession(here);
  const numberSystems = await getNumberSystems();
  const scope = {
    customerId: customerIds,
    ...(opportunityId !== undefined ? { opportunityId } : {}),
    ...(q !== undefined ? { q } : {}),
  };
  const filter: QuotationListFilter = { ...scope, status: statuses };
  const readPage = (page: number) =>
    listQuotationsPage(session, { ...filter, limit: rows, offset: pageWindow(page, rows).offset });

  // The three reads do not depend on each other. Only the quotations decide whether the page works:
  // without the customers the filter drops that field, without the summary the cards are left out.
  const [list, customers, summary] = await Promise.all([
    readPage(state.page).then(
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
    getQuotationsSummary(session, scope).then(
      (result) => result,
      () => null,
    ),
  ]);
  const { problem } = list;
  let result = list.result;
  let current = pageWindow(state.page, rows, result?.total);
  // A stale link past the last page lands on the last page instead of an empty table.
  if (result !== null && current.page !== state.page && result.total > 0) {
    result = await readPage(current.page).catch(() => result);
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
  // The opportunity is the page's scope, not a filter, so it is not named here.
  const activeFilters = activeFilterLabels(
    { q, multi: { status: statuses, customerId: customerIds }, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => STATUS_FILTER_OPTIONS.find((o) => o.value === v)?.label ?? v,
      },
      customerId: { label: 'Customer', format: customerName },
    },
  );
  const rowsHref = (size: number) =>
    hrefWith(PATH, params, { rows: size === QUOTATION_DEFAULT_ROWS ? undefined : size });

  return (
    <Page>
      <PageHeader
        title={opportunityId !== undefined ? 'Quotations for this opportunity' : 'Quotations'}
        description="Track drafts, approvals, and customer decisions."
        actions={
          opportunityId !== undefined ? (
            <LinkButton href={newQuotationHref(opportunityId, { another: true })}>
              New quotation
            </LinkButton>
          ) : null
        }
      />

      {items !== null && summary !== null ? (
        <QuotationStats summary={summary} filtered={filtered} numberSystems={numberSystems} />
      ) : null}

      <QuotationFilters
        opportunityId={opportunityId}
        rows={rows}
        statuses={statuses}
        customerIds={customerIds}
        statusOptions={STATUS_FILTER_OPTIONS}
        customerOptions={customerOptions}
      />
      {opportunityId !== undefined ? (
        <p>
          <Link href={`/opportunities/${encodeURIComponent(opportunityId)}`}>
            Back to the opportunity
          </Link>
        </p>
      ) : null}

      {items !== null ? <ResultCount shown={items.length} total={total} noun="quotation" /> : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include quotations'
              : 'The quotations did not load'
          }
          actions={problem.status !== 403 ? <Link href={here}>Reload the quotations</Link> : null}
        >
          {problem.status === 403
            ? 'Quotations are for the sales team and the people who approve them. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : items !== null && items.length === 0 ? (
        filtered ? (
          <EmptyState
            icon="search"
            title="No matching quotations."
            action={
              <LinkButton
                href={clearFiltersHref(PATH, params, QUOTATION_FILTER_SPEC)}
                variant="secondary"
              >
                Clear filters
              </LinkButton>
            }
          >
            {`Nothing matches ${activeFilters.join(' · ')}.`}
          </EmptyState>
        ) : opportunityId !== undefined ? (
          <EmptyState icon="file-text" title="No quotations for this opportunity yet.">
            Start one with New quotation. It appears here once it is saved.
          </EmptyState>
        ) : (
          <EmptyState icon="file-text" title="No quotations yet.">
            A quotation is prepared from an opportunity. It appears here once it is saved.
          </EmptyState>
        )
      ) : items !== null ? (
        <div className={styles.results}>
          <Table caption="Quotations" minWidth={760} className={styles.table ?? ''}>
            <thead>
              <tr>
                <Th>Quotation</Th>
                <Th>Organization</Th>
                <Th>Owner</Th>
                <Th className={styles.statusColumn}>Status</Th>
                <Th className={styles.actionColumn}>Valid until</Th>
                <Th className={styles.actionColumn}>Action</Th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <QuotationRow key={item.id} item={item} numberSystems={numberSystems} />
              ))}
            </tbody>
          </Table>
          <div className={styles.footer}>
            <Pagination
              summary={`Showing ${current.first}–${current.last} of ${total}`}
              currentPage={current.page}
              pages={Array.from({ length: Math.min(3, current.pageCount) }, (_, i) => {
                const page = Math.max(1, Math.min(current.page - 1, current.pageCount - 2)) + i;
                return { page, href: pageHref(page) };
              })}
              {...(current.page > 1 ? { previousHref: pageHref(current.page - 1) } : {})}
              {...(current.page < current.pageCount
                ? { nextHref: pageHref(current.page + 1) }
                : {})}
            />
            <nav aria-label="Rows per page" className={styles.pageSize}>
              <span aria-hidden="true">Rows</span>
              {QUOTATION_ROW_OPTIONS.map((size) => (
                <LinkButton
                  key={size}
                  href={rowsHref(size)}
                  size="small"
                  variant={size === rows ? 'secondary' : 'tertiary'}
                  aria-current={size === rows ? 'true' : undefined}
                  aria-label={`${size} rows per page`}
                >
                  {size}
                </LinkButton>
              ))}
            </nav>
          </div>
        </div>
      ) : null}
    </Page>
  );
}
