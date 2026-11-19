import { PR_STATUSES, PrStatusSchema, pageWindow } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';

import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { listPurchaseRequestsPage, type PurchaseRequestListItem } from '@/lib/api-procurement';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, hrefWith, readList } from '@/lib/list-params';

import layout from '../procurement.module.css';
import { prFailure } from './_lib/failure';
import { RequestsFilters } from './requests-filters';
import { PR_STATUS_LABEL, prGrants } from './_lib/model';
import styles from './requests.module.css';

export const metadata: Metadata = { title: 'Purchase requests · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/procurement/requests';
const LIST = { multi: { status: PR_STATUSES } } as const;

function Row({ pr, numberSystems }: { pr: PurchaseRequestListItem; numberSystems: NumberSystems }) {
  const status = PR_STATUS_LABEL[pr.status];
  return (
    <tr>
      <Td>
        <CellTitle
          title={
            <Link
              href={`/procurement/requests/${encodeURIComponent(pr.id)}`}
              className={styles.name}
            >
              {pr.number ?? 'Not numbered yet'}
            </Link>
          }
          note={<span className={styles.long}>{pr.justification}</span>}
        />
      </Td>
      <Td nowrap>
        {pr.departmentName ?? <span className={styles.numeric}>Department name unavailable</span>}
      </Td>
      <Td nowrap>{when(pr.requiredBy, 'date')}</Td>
      <Td align="end" nowrap>
        <span className={styles.numeric}>
          {money(pr.estimatedTotal, pr.currency, numberSystems)}
        </span>
      </Td>
      <Td nowrap>
        <span className={styles.badges}>
          <Badge tone={status.tone}>{status.text}</Badge>
          {pr.isEmergency ? <Badge tone="error">Emergency</Badge> : null}
        </span>
      </Td>
    </tr>
  );
}

export default async function PurchaseRequestsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const session = await requireStaffSession(PATH);
  const numberSystems = await getNumberSystems();
  const params = await searchParams;
  const list = readList(params, LIST);
  const status = PrStatusSchema.array().parse(list.multi.status);
  const grants = prGrants(session.roles);

  let requests: PurchaseRequestListItem[] | null = null;
  let total = 0;
  let window = pageWindow(list.page, list.rows);
  let problem: { message: string; status: number } | null = null;
  try {
    const fetchPage = () =>
      listPurchaseRequestsPage(session, {
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
    requests = result.items;
    total = result.total;
  } catch (err) {
    const f = prFailure(err, 'load');
    problem = { message: f.message, status: f.status };
  }

  const newButton = grants.create ? (
    <LinkButton href="/procurement/requests/new">New purchase request</LinkButton>
  ) : null;
  const filtered = activeFilterLabels(
    { q: list.q, multi: list.multi, single: {} },
    {
      status: {
        label: 'Status',
        format: (v) => PR_STATUS_LABEL[v as keyof typeof PR_STATUS_LABEL]?.text ?? v,
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
        title={grants.readAll ? 'Purchase requests' : 'My purchase requests'}
        description={
          grants.readAll
            ? 'Every purchase request in this entity, newest first. A request is approved by the department head before sourcing starts.'
            : 'The purchase requests you raised, newest first. A request is approved by the department head before sourcing starts.'
        }
        actions={newButton}
      />

      <RequestsFilters
        statusOptions={PR_STATUSES.map((s) => ({ value: s, label: PR_STATUS_LABEL[s].text }))}
        status={status}
        rows={typeof params.rows === 'string' ? params.rows : undefined}
      />

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={
            problem.status === 403
              ? 'Your roles do not include purchase requests'
              : 'Purchase requests did not load'
          }
          actions={
            problem.status !== 403 ? (
              <Link href={hrefWith(PATH, params, {})}>Reload purchase requests</Link>
            ) : null
          }
        >
          {problem.status === 403
            ? 'Purchase requests are for staff who raise or source purchases. Ask an administrator if you need access.'
            : problem.message}
        </Alert>
      ) : requests !== null && requests.length === 0 ? (
        filtered.length > 0 ? (
          <EmptyState
            title="No purchase requests match."
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
          <EmptyState title="No purchase requests yet." icon="file-text" action={newButton}>
            {grants.create
              ? 'Raise a request for what the business needs. The department head approves it before anyone sources it.'
              : 'Requests raised by staff will show here.'}
          </EmptyState>
        )
      ) : requests !== null ? (
        <div className={layout.results}>
          <ResultCount shown={requests.length} total={total} noun="request" />
          <Table className={layout.resultsTable ?? ''} caption="Purchase requests" minWidth={720}>
            <thead>
              <tr>
                <Th>Request</Th>
                <Th>Department</Th>
                <Th>Needed by</Th>
                <Th align="end">Estimated total</Th>
                <Th>Status</Th>
              </tr>
            </thead>
            <tbody>
              {requests.map((pr) => (
                <Row numberSystems={numberSystems} key={pr.id} pr={pr} />
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
