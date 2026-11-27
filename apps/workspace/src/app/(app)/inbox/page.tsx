import { type InboxItemDto, pageWindow, ROWS_OPTIONS } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystems } from '@bos/locale';

import { ListFooter } from '@/components/p2/crm/list-footer';
import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { ResultCount } from '@/components/ui/filter-bar';
import { Page, PageHeader } from '@/components/ui/page';
import { StatCard } from '@/components/ui/stat-card';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf, getInbox, getInboxPage, type InboxPage } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystems } from '@/lib/display-settings';
import { documentNumberText, money, when } from '@/lib/kernel-format';
import { activeFilterLabels, clearFiltersHref, readList, type RawParams } from '@/lib/list-params';

import { EyeIcon } from '../memos/memo-icons';
import { RowActionLink, RowActions } from '../memos/row-action-link';
import { INBOX_DENIED, inboxDenialMessage } from './denial';
import { DecisionFeedback } from './decision-feedback';
import { InboxFilters } from './inbox-filters';
import { documentTypeLabel, INBOX_LIST } from './inbox-params';
import { inboxSummaryCards } from './inbox-summary';
import styles from './inbox.module.css';

export const metadata: Metadata = { title: 'Inbox · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/inbox';

function InboxRow({ item, numberSystems }: { item: InboxItemDto; numberSystems: NumberSystems }) {
  return (
    <tr>
      <Td>
        <CellTitle
          title={<Link href={`/inbox/${encodeURIComponent(item.requestId)}`}>{item.title}</Link>}
          meta={
            <>
              <span className="sr-only">Document number: </span>
              {documentNumberText(item.documentNumber)}
            </>
          }
        />
      </Td>
      <Td className={styles.reason}>{item.reason}</Td>
      <Td align="end" nowrap>
        {item.amountNpr !== null ? (
          <span className={styles.amount}>{money(item.amountNpr, 'NPR', numberSystems)}</span>
        ) : (
          <span className={styles.quiet}>No amount</span>
        )}
      </Td>
      <Td nowrap>
        <time dateTime={item.submittedAt}>{when(item.submittedAt)}</time>
      </Td>
      <Td align="end">
        <RowActions>
          <RowActionLink
            href={`/inbox/${encodeURIComponent(item.requestId)}`}
            label={`Review ${item.title}`}
            tooltip="Review request"
          >
            <EyeIcon size={18} />
          </RowActionLink>
        </RowActions>
      </Td>
    </tr>
  );
}

export default async function InboxPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const session = await requireStaffSession(PATH);
  const sp = await searchParams;
  const state = readList(sp, INBOX_LIST);
  const { q } = state;
  const documentType = state.multi.documentType;
  const decided = [sp.decided].flat()[0];
  const filtered = q !== undefined || documentType.length > 0;
  const filters = { ...(q !== undefined ? { q } : {}), documentType };

  let result: InboxPage | null = null;
  let pageInfo = pageWindow(state.page, state.rows);
  let problem: { message: string; status: number } | null = null;
  // The list read starts first; display settings and the whole unfiltered inbox (the KPI cards) start
  // with it instead of after it. Neither throws: a failed inbox read leaves the cards out. If the list
  // is denied, the cards are dropped below and the extra read is the only cost.
  const firstRead = getInboxPage(session, {
    ...filters,
    limit: pageInfo.limit,
    offset: pageInfo.offset,
  });
  const numberSystemsRead = getNumberSystems();
  const summaryRead = getInbox(session).then(inboxSummaryCards, () => []);
  try {
    result = await firstRead;
    pageInfo = pageWindow(pageInfo.page, pageInfo.limit, result.total);
    if (result.items.length === 0 && result.total > 0) {
      // The URL named a page past the end: show the last one instead of an empty table.
      result = await getInboxPage(session, {
        ...filters,
        limit: pageInfo.limit,
        offset: pageInfo.offset,
      });
    }
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.status === 403 ? inboxDenialMessage(err) : f.message, status: f.status };
  }
  const [numberSystems, cards] = await Promise.all([numberSystemsRead, summaryRead]);
  const summary = problem === null ? cards : [];
  const items = result?.items ?? null;
  const total = result?.total ?? 0;
  const hiding = activeFilterLabels(
    { q, multi: { documentType }, single: {} },
    { documentType: { label: 'Document type', format: documentTypeLabel } },
    'Search',
  );

  return (
    <Page>
      <PageHeader title="Inbox" description="Review requests assigned to you for approval." />
      {decided === 'approve' || decided === 'return' || decided === 'reject' ? (
        <DecisionFeedback decision={decided} />
      ) : null}

      {problem !== null ? (
        <Alert
          tone={problem.status === 403 ? 'info' : 'error'}
          role="alert"
          title={problem.status === 403 ? "You can't open the inbox" : 'The inbox did not load'}
          actions={problem.status !== 403 ? <Link href="/inbox">Reload the inbox</Link> : null}
        >
          {problem.status === 403 && problem.message === INBOX_DENIED
            ? 'If you expect documents to approve here, ask an administrator to check your account.'
            : problem.message}
        </Alert>
      ) : items !== null && items.length === 0 && !filtered ? (
        <EmptyState title="Nothing is waiting for you.">
          New approvals appear here, and the bell above tells you when one arrives.
        </EmptyState>
      ) : items !== null ? (
        <div className={styles.results}>
          {summary.length > 0 ? (
            <section className={styles.stats} aria-label="Inbox summary">
              {summary.map((card) => (
                <StatCard key={card.key} label={card.label} value={card.value} icon={card.icon} />
              ))}
            </section>
          ) : null}
          <div className={styles.toolbar}>
            <InboxFilters documentType={documentType} rows={state.rows} decided={decided} />
            <ResultCount shown={items.length} total={total} noun="request" />
          </div>
          {items.length === 0 ? (
            <EmptyState
              title="No matching requests"
              action={<Link href={clearFiltersHref(PATH, sp, INBOX_LIST)}>Clear filters</Link>}
            >
              Nothing waiting for you matches {hiding.join(', ')}.
            </EmptyState>
          ) : (
            <div className={styles.tableCard}>
              <Table caption="Waiting approvals" minWidth={760} className={styles.table ?? ''}>
                <thead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Approval reason</Th>
                    <Th align="end">Amount</Th>
                    <Th>Submitted</Th>
                    <Th align="end">
                      <span className="sr-only">Actions</span>
                    </Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <InboxRow numberSystems={numberSystems} key={item.requestId} item={item} />
                  ))}
                </tbody>
              </Table>
              <div className={styles.tableFooter}>
                <ListFooter
                  label="Inbox pages"
                  pathname={PATH}
                  params={sp}
                  pageInfo={pageInfo}
                  total={total}
                  noun="request"
                  plural="requests"
                  rowsOptions={ROWS_OPTIONS}
                />
              </div>
            </div>
          )}
        </div>
      ) : null}
    </Page>
  );
}
