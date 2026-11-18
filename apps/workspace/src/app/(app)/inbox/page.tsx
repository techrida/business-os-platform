import type { InboxItemDto } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { getInbox, failureOf } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { money, when } from '@/lib/kernel-format';

import { INBOX_DENIED, inboxDenialMessage } from './denial';
import styles from './inbox.module.css';

export const metadata: Metadata = { title: 'Inbox · Business OS' };
export const dynamic = 'force-dynamic';

/** What the banner says after a decision. Only these keys are accepted from the query string. */
const DECIDED: Record<string, string> = {
  approve: 'Your approval was recorded.',
  return: 'The request was returned to the person who prepared it.',
  reject: 'The request was rejected.',
};

function InboxRow({ item }: { item: InboxItemDto }) {
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
          // The reason is the point of the inbox: why this one is yours.
          note={
            <>
              <span className="sr-only">Why it is yours: </span>
              {item.reason}
            </>
          }
        />
      </Td>
      <Td align="end" nowrap>
        {item.amountNpr !== null ? (
          <span className={styles.amount}>{money(item.amountNpr, 'NPR')}</span>
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
  searchParams: Promise<{ decided?: string | string[] }>;
}) {
  const session = await requireStaffSession('/inbox');
  const { decided } = await searchParams;
  const decidedKey = typeof decided === 'string' ? decided : undefined;
  const banner = decidedKey !== undefined ? DECIDED[decidedKey] : undefined;

  let items: InboxItemDto[] | null = null;
  let problem: { message: string; status: number } | null = null;
  try {
    items = await getInbox(session);
  } catch (err) {
    const f = failureOf(err);
    problem = { message: f.status === 403 ? inboxDenialMessage(err) : f.message, status: f.status };
  }

  return (
    <Page>
      <PageHeader
        title="Inbox"
        description="Documents waiting for your decision. Each shows why the approval route sent it to you."
        actions={
          items !== null && items.length > 0 ? (
            <Badge tone="info" role="status" className={styles.count}>
              {items.length} waiting
            </Badge>
          ) : null
        }
      />

      {banner !== undefined ? (
        <Alert tone="success" role="status">
          {banner}
        </Alert>
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
      ) : items !== null ? (
        <Table caption="Waiting approvals" minWidth={640}>
          <thead>
            <tr>
              <Th>Document</Th>
              <Th align="end">Amount</Th>
              <Th>Submitted</Th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <InboxRow key={item.requestId} item={item} />
            ))}
          </tbody>
        </Table>
      ) : null}
    </Page>
  );
}
