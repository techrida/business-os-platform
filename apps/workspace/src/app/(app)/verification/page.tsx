import {
  pageWindow,
  type VerificationCaseDto,
  type VerificationStatus,
} from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { listVerificationCasePage } from '@/components/p2/customers/api';
import {
  checklistProgress,
  parseStatusFilters,
  VERIFICATION_STATUS_LABEL,
} from '@/components/p2/customers/format';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';

import styles from './verification.module.css';
import { VerificationFilters } from './verification-filters';

export const metadata: Metadata = { title: 'Verification · Business OS' };
export const dynamic = 'force-dynamic';

const DEFAULT_PAGE_SIZE = 25;
/** The URL is the state: repeated `status`, `q`, `page` and `rows` (the API caps a page at 100). */
const LIST = {
  rows: { allowed: [10, DEFAULT_PAGE_SIZE, 50, 100], default: DEFAULT_PAGE_SIZE },
} as const;
const FILTER_LABELS = {
  status: {
    label: 'Status',
    format: (v: string) => VERIFICATION_STATUS_LABEL[v as VerificationStatus]?.text ?? v,
  },
};

/** The party's name as the case list sends it (customer or vendor), or an explicit unavailable state. */
function partyLabel(c: VerificationCaseDto): string {
  if (c.partyName !== undefined && c.partyName !== null && c.partyName !== '') return c.partyName;
  return c.partyKind === 'vendor' ? 'Vendor name unavailable' : 'Customer name unavailable';
}

function Row({ c }: { c: VerificationCaseDto }) {
  const status = VERIFICATION_STATUS_LABEL[c.status];
  const progress = checklistProgress(c.checklist);
  const named = c.partyName !== undefined && c.partyName !== null && c.partyName !== '';
  const name = partyLabel(c);
  const number = c.partyNumber ?? null;
  return (
    <tr>
      <Td className={styles.customerCell}>
        <div className={styles.customer}>
          {named ? (
            <Avatar name={name} size="medium" shape="circle" />
          ) : (
            <span className={styles.customerIcon}>
              <Icon name="building" size={16} />
            </span>
          )}
          <CellTitle
            title={<Link href={`/verification/${encodeURIComponent(c.id)}`}>{name}</Link>}
            note={
              number !== null ? (
                <>
                  <span className="sr-only">Customer number: </span>
                  {number}
                </>
              ) : c.partyKind === 'vendor' ? (
                'Vendor'
              ) : null
            }
          />
        </div>
      </Td>
      <Td nowrap>
        <Badge tone={status.tone}>{status.text}</Badge>
      </Td>
      <Td nowrap>
        {progress.required === 0 ? (
          <span className={styles.quiet}>None required</span>
        ) : (
          <div className={styles.rowProgress}>
            <span>
              {progress.accepted} of {progress.required} accepted
            </span>
            <progress aria-hidden="true" value={progress.accepted} max={progress.required} />
          </div>
        )}
      </Td>
      <Td nowrap>
        {c.decidedAt !== null ? (
          <time dateTime={c.decidedAt}>{when(c.decidedAt)}</time>
        ) : (
          <span className={styles.quiet}>Not decided</span>
        )}
      </Td>
    </tr>
  );
}

export default async function VerificationQueuePage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const session = await requireStaffSession('/verification');
  const params = await searchParams;
  // No default status: with none chosen the queue lists every case.
  const status = parseStatusFilters(params.status);
  const { q, page, rows: pageSize } = readList(params, { ...LIST, multi: {} });
  const at = (patch: Parameters<typeof hrefWith>[2]) => hrefWith('/verification', params, patch);

  let cases: VerificationCaseDto[] | null = null;
  let total: number | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    const window = pageWindow(page, pageSize);
    const result = await listVerificationCasePage(session, {
      ...(q !== undefined ? { q } : {}),
      ...(status.length > 0 ? { status } : {}),
      limit: window.limit,
      offset: window.offset,
    });
    cases = result.items;
    total = result.total;
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.message, status: f.status };
  }
  const hasNext =
    cases !== null && (total !== null ? page * pageSize < total : cases.length === pageSize);
  const first = (page - 1) * pageSize + 1;
  const filtersOn = activeFilterLabels(
    { q, multi: { status }, single: {} },
    FILTER_LABELS,
    'Search',
  );
  const clearHref = clearFiltersHref('/verification', params, { ...LIST, multi: { status: [] } });

  return (
    <Page>
      <PageHeader
        title="Verification"
        description="Review customer documents and track verification decisions."
      />

      <div className={styles.queue}>
        <VerificationFilters
          status={status}
          rows={pageSize !== DEFAULT_PAGE_SIZE ? pageSize : undefined}
        />
        {total !== null && cases !== null ? (
          <ResultCount shown={cases.length} total={total} noun="case" />
        ) : null}

        {problem !== null ? (
          <Alert
            tone={problem.status === 403 ? 'info' : 'error'}
            role="alert"
            title={
              problem.status === 403
                ? 'Your roles do not include verification'
                : 'The verification queue did not load'
            }
            actions={
              problem.status !== 403 ? (
                <Link href={at({ page: page > 1 ? page : null })}>Reload the queue</Link>
              ) : null
            }
          >
            {problem.status === 403
              ? 'Verification is for the people who review customer documents. Ask an administrator if you need it.'
              : problem.message}
          </Alert>
        ) : cases !== null && cases.length === 0 ? (
          filtersOn.length > 0 ? (
            <EmptyState
              title="No cases match."
              icon="shield-check"
              action={
                <LinkButton href={clearHref} variant="secondary">
                  Clear filters
                </LinkButton>
              }
            >
              Hidden by {filtersOn.join('; ')}.
            </EmptyState>
          ) : page > 1 ? (
            <EmptyState title="There are no more cases." icon="shield-check">
              <Link href={at({ page: null })}>Back to the first page</Link>
            </EmptyState>
          ) : (
            <EmptyState title="No verification cases yet." icon="shield-check">
              A customer appears here when their documents are submitted for verification.
            </EmptyState>
          )
        ) : cases !== null ? (
          <Card className={styles.queueResults}>
            <Table caption="Verification cases" minWidth={610} className={styles.queueTable ?? ''}>
              <thead>
                <tr>
                  <Th>Organization</Th>
                  <Th>Status</Th>
                  <Th>Required documents</Th>
                  <Th>Decided</Th>
                </tr>
              </thead>
              <tbody>
                {cases.map((c) => (
                  <Row key={c.id} c={c} />
                ))}
              </tbody>
            </Table>
            <Pagination
              label="Case pages"
              summary={`Showing ${first}–${first + cases.length - 1}${total !== null ? ` of ${total}` : ''}`}
              {...(page > 1 ? { previousHref: at({ page: page - 1 > 1 ? page - 1 : null }) } : {})}
              {...(hasNext ? { nextHref: at({ page: page + 1 }) } : {})}
            />
          </Card>
        ) : null}
      </div>
    </Page>
  );
}
