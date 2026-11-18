import type { QuotationListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listQuotations } from '@/components/p2/quotations/api';
import styles from '@/components/p2/quotations/list.module.css';
import {
  parseStatusFilter,
  quotationStatusMeta,
  STATUS_FILTER_OPTIONS,
} from '@/components/p2/quotations/status';
import { editQuotationHref, newQuotationHref } from '@/components/p2/quotations/resume';
import { QuotationStatusBadge } from '@/components/p2/quotations/status-badge';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

export const metadata: Metadata = { title: 'Quotations · Business OS' };
export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The opportunity filter: one UUID, else none (a malformed id is ignored, never sent). */
function parseOpportunityFilter(raw: string | string[] | undefined): string | undefined {
  return typeof raw === 'string' && UUID.test(raw) ? raw : undefined;
}

const ROW_OPTIONS = [5, 10, 20] as const;

function listHref(filters: {
  status?: string | undefined;
  opportunityId?: string | undefined;
  q?: string | undefined;
  rows?: number | undefined;
  page?: number | undefined;
}) {
  const params = new URLSearchParams();
  if (filters.opportunityId) params.set('opportunityId', filters.opportunityId);
  if (filters.status) params.set('status', filters.status);
  if (filters.q) params.set('q', filters.q);
  if (filters.rows && filters.rows !== ROW_OPTIONS[0]) params.set('rows', String(filters.rows));
  if (filters.page && filters.page > 1) params.set('page', String(filters.page));
  return params.size === 0 ? '/quotations' : `/quotations?${params.toString()}`;
}

function QuotationRow({ item }: { item: QuotationListItem }) {
  const href = `/quotations/${encodeURIComponent(item.id)}`;
  return (
    <tr>
      <Td>
        <Link href={href} className={styles.number}>
          {item.number}
        </Link>
        <span className={styles.amount}>{money(item.total, item.currency)}</span>
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

function QuotationStats({ items }: { items: QuotationListItem[] }) {
  const count = (status: QuotationListItem['status']) =>
    items.filter((item) => item.status === status).length;
  return (
    <section className={styles.stats} aria-label="Quotation totals by status">
      <StatCard label="Total quotations" value={items.length} icon="file-text" />
      <StatCard
        label="Internal approval"
        value={count('submitted')}
        icon="shield-check"
        tone="warning"
      />
      <StatCard label="In customer review" value={count('sent')} icon="users" />
      <StatCard label="Accepted" value={count('accepted')} icon="check-circle" tone="success" />
    </section>
  );
}

export default async function QuotationsPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const {
    status: rawStatus,
    opportunityId: rawOpportunity,
    q: rawQuery,
    rows,
    page,
  } = await searchParams;
  const status = parseStatusFilter(rawStatus);
  const opportunityId = parseOpportunityFilter(rawOpportunity);
  const q = typeof rawQuery === 'string' ? rawQuery.trim().slice(0, 120) : '';
  const pageSize = ROW_OPTIONS.find((option) => String(option) === rows) ?? ROW_OPTIONS[0];
  const requestedPage = typeof page === 'string' && /^\d+$/.test(page) ? Number(page) : 1;
  const filters = { status, opportunityId, q, rows: pageSize };
  const here = listHref({ ...filters, page: requestedPage });
  const session = await requireStaffSession(here);

  let items: QuotationListItem[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const scope = opportunityId !== undefined ? { opportunityId } : {};
    items = await listQuotations(session, status === undefined ? scope : { ...scope, status });
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }

  const search = q.toLowerCase();
  const matches = (items ?? []).filter((item) =>
    [item.number, item.customerName, item.ownerName].some((value) =>
      value?.toLowerCase().includes(search),
    ),
  );
  const pageCount = Math.ceil(matches.length / pageSize);
  const currentPage = Math.max(1, Math.min(requestedPage, pageCount));
  const offset = (currentPage - 1) * pageSize;
  const pageHref = (next: number) => listHref({ ...filters, page: next });

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

      {items !== null && status === undefined && opportunityId === undefined && !q ? (
        <QuotationStats items={items} />
      ) : null}

      <form method="get" action="/quotations" className={styles.toolbar}>
        {opportunityId !== undefined ? (
          <input type="hidden" name="opportunityId" value={opportunityId} />
        ) : null}
        {pageSize !== ROW_OPTIONS[0] ? <input type="hidden" name="rows" value={pageSize} /> : null}
        <SearchInput
          name="q"
          defaultValue={q}
          maxLength={120}
          aria-label="Search quotations"
          placeholder="Search quotations"
          wrapperClassName={styles.search}
        />
        <div className={styles.toolbarActions}>
          <Select
            name="status"
            aria-label="Quotation status"
            className={styles.filter}
            defaultValue={status ?? ''}
          >
            <option value="">All statuses</option>
            {STATUS_FILTER_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </Select>
          <Button type="submit" variant="secondary">
            Apply filters
          </Button>
          {status !== undefined || opportunityId !== undefined || q !== '' ? (
            <Link href="/quotations">Show all quotations</Link>
          ) : null}
          {opportunityId !== undefined ? (
            <Link href={`/opportunities/${encodeURIComponent(opportunityId)}`}>
              Back to the opportunity
            </Link>
          ) : null}
        </div>
      </form>

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
      ) : matches.length === 0 ? (
        q !== '' ? (
          <EmptyState icon="search" title="No matching quotations">
            Try another quotation number, organization, or owner.
          </EmptyState>
        ) : status !== undefined ? (
          <EmptyState
            icon="file-text"
            title={`No quotations are ${quotationStatusMeta(status).label.toLowerCase()}.`}
          >
            Choose another status, or show all quotations.
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
      ) : (
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
              {matches.slice(offset, offset + pageSize).map((item) => (
                <QuotationRow key={item.id} item={item} />
              ))}
            </tbody>
          </Table>
          <div className={styles.footer}>
            <Pagination
              summary={`Showing ${offset + 1}–${Math.min(offset + pageSize, matches.length)} of ${matches.length}`}
              currentPage={currentPage}
              pages={Array.from({ length: Math.min(3, pageCount) }, (_, i) => {
                const page = Math.max(1, Math.min(currentPage - 1, pageCount - 2)) + i;
                return { page, href: pageHref(page) };
              })}
              {...(currentPage > 1 ? { previousHref: pageHref(currentPage - 1) } : {})}
              {...(currentPage < pageCount ? { nextHref: pageHref(currentPage + 1) } : {})}
            />
            <nav aria-label="Rows per page" className={styles.pageSize}>
              <span aria-hidden="true">Rows</span>
              {ROW_OPTIONS.map((size) => (
                <LinkButton
                  key={size}
                  href={listHref({ ...filters, rows: size })}
                  size="small"
                  variant={size === pageSize ? 'secondary' : 'tertiary'}
                  aria-current={size === pageSize ? 'true' : undefined}
                  aria-label={`${size} rows per page`}
                >
                  {size}
                </LinkButton>
              ))}
            </nav>
          </div>
        </div>
      )}
    </Page>
  );
}
