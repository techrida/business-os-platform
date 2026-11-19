import { RFQ_STATUSES, RfqStatusSchema, pageWindow, type RfqListItem } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';

import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listRfqsPage } from '@/lib/api-rfqs';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import layout from '../procurement.module.css';
import styles from '../requests/requests.module.css';
import { rfqFailure } from './_lib/failure';
import { RFQ_STATUS_LABEL, rfqGrants } from './_lib/model';
import { RfqsFilters } from './rfqs-filters';

export const metadata: Metadata = { title: 'Requests for quotation · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/procurement/rfqs';
const LIST = { multi: { status: RFQ_STATUSES } } as const;

function Row({ rfq }: { rfq: RfqListItem }) {
  const status = RFQ_STATUS_LABEL[rfq.status];
  return (
    <tr>
      <Td>
        <CellTitle
          title={
            <Link href={`/procurement/rfqs/${encodeURIComponent(rfq.id)}`} className={styles.name}>
              {rfq.number}
            </Link>
          }
        />
      </Td>
      <Td nowrap>
        <Link
          href={`/procurement/requests/${encodeURIComponent(rfq.purchaseRequestId)}`}
          className={styles.numeric}
        >
          {rfq.purchaseRequestNumber ?? 'Not numbered yet'}
        </Link>
      </Td>
      <Td nowrap>{when(rfq.deadline)}</Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {rfq.quotationCount} of {rfq.invitedVendorCount}
        </span>
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
    </tr>
  );
}

export default async function RfqsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = RfqStatusSchema.array().parse(list.multi.status);
  const grants = rfqGrants(session.roles);

  let rfqs: RfqListItem[] | null = null;
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  let problem: { message: string; status: number } | null = null;
  try {
    const fetchPage = () =>
      listRfqsPage(session, {
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
    rfqs = result.items;
    total = result.total;
  } catch (err) {
    const f = rfqFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => RFQ_STATUS_LABEL[v as keyof typeof RFQ_STATUS_LABEL]?.text ?? v,
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
        title="Requests for quotation"
        description="RFQs sent to approved vendors for a department-approved purchase request, newest first. Open one to enter quotations, compare them and recommend one."
        actions={
          grants.sourcing ? <LinkButton href="/procurement/rfqs/new">New RFQ</LinkButton> : null
        }
      />

      <RfqsFilters
        statusOptions={RFQ_STATUSES.map((s) => ({ value: s, label: RFQ_STATUS_LABEL[s].text }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include sourcing'
              : 'Requests for quotation did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={hrefWith(PATH, params, {})}>Reload the list</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'RFQs are for procurement staff who source purchases. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : rfqs !== null && rfqs.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No RFQs match."
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
          <EmptyState
            title="No RFQs yet."
            icon="file-text"
            action={
              grants.sourcing ? <LinkButton href="/procurement/rfqs/new">New RFQ</LinkButton> : null
            }
          >
            {grants.sourcing
              ? 'Open an RFQ on a department-approved purchase request to ask approved vendors for quotations.'
              : 'RFQs opened by procurement will show here.'}
          </EmptyState>
        )
      ) : rfqs !== null ? (
        <div className={layout.results}>
          <ResultCount shown={rfqs.length} total={total} noun="RFQ" />
          <Table
            className={layout.resultsTable ?? ''}
            caption="Requests for quotation"
            minWidth={720}
          >
            <thead>
              <tr>
                <Th>RFQ</Th>
                <Th>Purchase request</Th>
                <Th>Deadline</Th>
                <Th align="end">Quotations</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {rfqs.map((rfq) => (
                <Row key={rfq.id} rfq={rfq} />
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
