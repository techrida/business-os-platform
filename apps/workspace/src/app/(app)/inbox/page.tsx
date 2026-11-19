import type { InboxItemDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';
import type { NumberSystem } from '@bos/locale';

import { Alert } from '@/components/ui/alert';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { SearchInput } from '@/components/ui/search-input';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getInbox, failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { getNumberSystem } from '@/lib/display-settings';
import { money, when } from '@/lib/kernel-format';

import { INBOX_DENIED, inboxDenialMessage } from './denial';
import { DecisionFeedback } from './decision-feedback';
import styles from './inbox.module.css';

export const metadata: Metadata = { title: 'Inbox · Business OS' };
export const dynamic = 'force-dynamic';

function InboxRow({ item, numberSystem }: { item: InboxItemDto; numberSystem: NumberSystem }) {
  return (
    <tr>
      <Td>
        <CellTitle
          title={<Link href={`/inbox/${encodeURIComponent(item.requestId)}`}>{item.title}</Link>}
          meta={
            <>
              <span className="sr-only">Document number: </span>
              {item.documentNumber}
            </>
          }
        />
      </Td>
      <Td className={styles.reason}>{item.reason}</Td>
      <Td align="end" nowrap>
        {item.amountNpr !== null ? (
          <span className={styles.amount}>{money(item.amountNpr, 'NPR', numberSystem)}</span>
        ) : (
          <span className={styles.quiet}>No amount</span>
        )}
      </Td>
      <Td nowrap>
        <time dateTime={item.submittedAt}>{when(item.submittedAt)}</time>
      </Td>
    </tr>
  );
}

export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<{ decided?: string | string[]; q?: string | string[] }>;
}) {
  const session = await requireStaffSession('/inbox');
  const numberSystem = await getNumberSystem();
  const { decided, q } = await searchParams;
  const query = typeof q === 'string' ? q.trim().slice(0, 120) : '';
  const search = query.toLowerCase();

  let items: InboxItemDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await getInbox(session);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.status === 403 ? inboxDenialMessage(err) : f.message, status: f.status };
  }

  const matches = items?.filter(
    ({ title, documentNumber, reason }) =>
      title.toLowerCase().includes(search) ||
      documentNumber.toLowerCase().includes(search) ||
      reason.toLowerCase().includes(search),
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
      ) : items !== null && items.length === 0 ? (
        <EmptyState title="Nothing is waiting for you.">
          New approvals appear here, and the bell above tells you when one arrives.
        </EmptyState>
      ) : items !== null && matches !== undefined ? (
        <div className={styles.results}>
          <form action="/inbox" role="search" aria-label="Inbox" className={styles.toolbar}>
            <SearchInput
              aria-label="Search approvals"
              name="q"
              placeholder="Search approvals"
              defaultValue={query}
              maxLength={120}
            />
            <Button type="submit" variant="secondary">
              Search
            </Button>
            {query ? (
              <LinkButton href="/inbox" variant="tertiary">
                Clear search
              </LinkButton>
            ) : null}
          </form>
          {matches.length === 0 ? (
            <EmptyState title="No matching requests">
              Search by document title, number or approval reason.
            </EmptyState>
          ) : (
            <div className={styles.tableCard}>
              <Table caption="Waiting approvals" minWidth={680} className={styles.table ?? ''}>
                <thead>
                  <tr>
                    <Th>Document</Th>
                    <Th>Approval reason</Th>
                    <Th align="end">Amount</Th>
                    <Th>Submitted</Th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((item) => (
                    <InboxRow numberSystem={numberSystem} key={item.requestId} item={item} />
                  ))}
                </tbody>
              </Table>
              <p className={styles.tableFooter}>
                {query
                  ? `Showing ${matches.length} of ${items.length} requests`
                  : `${items.length} ${items.length === 1 ? 'request' : 'requests'} waiting`}
              </p>
            </div>
          )}
        </div>
      ) : null}
    </Page>
  );
}
