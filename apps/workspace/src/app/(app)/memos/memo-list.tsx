import type { MemoListItem } from '@bos/contracts';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/panel';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf, listMemos } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import { memoRowNote, MEMO_PAGE_SIZE, MEMO_STATUS_FILTERS } from '@/lib/memo-list-view';

import { StatusBadge } from '../kit';
import styles from '../kit.module.css';
import { PlusIcon } from './memo-icons';

/** The page's list: loads one page of the memos this person may open. Rendered inside Suspense by page.tsx. */
export async function MemoList({
  cursor,
  status,
}: {
  cursor: string | undefined;
  status: string | undefined;
}) {
  const session = await requireStaffSession('/memos');
  const filter = MEMO_STATUS_FILTERS.find((f) => f.value === status)?.value;
  let page;
  try {
    page = await listMemos(session, {
      limit: MEMO_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(filter !== undefined ? { status: filter } : {}),
    });
  } catch (err) {
    const f = failureOf(err);
    // A cursor the API refuses (edited by hand, or from an old link) is not a server fault: say so and offer page one.
    const staleLink = f.status === 400 && cursor !== undefined;
    return (
      <Alert
        tone={staleLink ? 'warning' : f.status === 403 ? 'info' : 'error'}
        role="alert"
        title={
          staleLink
            ? 'That page of memos is no longer available'
            : f.status === 403
              ? 'Your roles do not include reading memos'
              : 'The memos did not load'
        }
        actions={
          staleLink ? (
            <Link href="/memos">Show the newest memos</Link>
          ) : f.status !== 403 ? (
            <Link href={filter ? `/memos?status=${filter}` : '/memos'}>Try again</Link>
          ) : null
        }
      >
        {staleLink
          ? 'The list was reordered or the link was changed. Start again from the newest memo.'
          : f.status === 403
            ? 'Ask an administrator for access if you need to prepare memos.'
            : f.message}
      </Alert>
    );
  }

  if (page.items.length === 0) {
    return filter !== undefined ? (
      <EmptyState
        title="No memos with this status"
        action={
          <LinkButton href="/memos" variant="secondary">
            Show every memo
          </LinkButton>
        }
      >
        Nothing you can open has this status right now.
      </EmptyState>
    ) : (
      <EmptyState
        title="No memos yet"
        action={
          <LinkButton href="/memos/new">
            <PlusIcon />
            New memo
          </LinkButton>
        }
      >
        Memos you prepare, and ones your role can read, appear here.
      </EmptyState>
    );
  }

  const next = new URLSearchParams();
  if (page.nextCursor !== null) next.set('cursor', page.nextCursor);
  if (filter !== undefined) next.set('status', filter);

  return (
    <>
      <Table caption="Memos, newest first" minWidth={520}>
        <thead>
          <tr>
            <Th>Memo</Th>
            <Th>Status</Th>
            <Th>Created</Th>
          </tr>
        </thead>
        <tbody>
          {page.items.map((m) => (
            <MemoRow key={m.id} memo={m} />
          ))}
        </tbody>
      </Table>
      {page.nextCursor !== null || cursor !== undefined ? (
        <nav className={styles.pager} aria-label="Memo pages">
          {cursor !== undefined ? (
            <LinkButton href={filter ? `/memos?status=${filter}` : '/memos'} variant="secondary">
              Newest memos
            </LinkButton>
          ) : null}
          {page.nextCursor !== null ? (
            <LinkButton href={`/memos?${next.toString()}`} variant="secondary">
              Older memos
            </LinkButton>
          ) : null}
        </nav>
      ) : null}
    </>
  );
}

function MemoRow({ memo }: { memo: MemoListItem }) {
  const note = memoRowNote(memo);
  return (
    <tr>
      <Td>
        <CellTitle
          title={<Link href={`/memos/${encodeURIComponent(memo.id)}`}>{memo.title}</Link>}
          meta={
            <>
              <span className="sr-only">Memo number: </span>
              {memo.number}
            </>
          }
          note={note}
        />
      </Td>
      <Td nowrap>
        <StatusBadge status={memo.status} />
      </Td>
      <Td nowrap>
        <time dateTime={memo.createdAt}>{when(memo.createdAt)}</time>
      </Td>
    </tr>
  );
}

export function MemoListSkeleton() {
  return (
    <div aria-busy="true">
      <p className="sr-only" role="status">
        Loading memos
      </p>
      <div aria-hidden="true" className={styles.listSkeleton}>
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} height={56} />
        ))}
      </div>
    </div>
  );
}
