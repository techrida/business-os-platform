import type { MemoListItem } from '@bos/contracts';
import Link from 'next/link';

import { Alert } from '@/components/ui/alert';
import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { ResultCount } from '@/components/ui/filter-bar';
import { Icon } from '@/components/ui/icon';
import { Skeleton } from '@/components/ui/panel';
import { CellTitle, Table, Td, Th } from '@/components/ui/table';
import { failureOf, listMemos } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { when } from '@/lib/kernel-format';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';
import { memoRowNote, MEMO_PAGE_SIZE } from '@/lib/memo-list-view';

import styles from '../kit.module.css';
import { PlusIcon } from './memo-icons';
import pageStyles from './memo-pages.module.css';
import { cursorOf, MEMO_LIST_SPEC, statusLabel } from './memo-list-params';
import { MemoStatus } from './memo-status';

/** The page's list: loads one page of the memos this person may open. Rendered inside Suspense by page.tsx. */
export async function MemoList({ params }: { params: RawParams }) {
  const session = await requireStaffSession('/memos');
  const { q, multi } = readList(params, MEMO_LIST_SPEC);
  const cursor = cursorOf(params);
  let page;
  try {
    page = await listMemos(session, {
      limit: MEMO_PAGE_SIZE,
      ...(cursor !== undefined ? { cursor } : {}),
      ...(multi.status.length > 0 ? { status: multi.status } : {}),
      ...(q !== undefined ? { q } : {}),
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
            <Link href={hrefWith('/memos', params, {})}>Show the newest memos</Link>
          ) : f.status !== 403 ? (
            <Link href={hrefWith('/memos', params, { page: cursor })}>Try again</Link>
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
    const hiding = activeFilterLabels(
      { q, multi, single: {} },
      { status: { label: 'Status', format: statusLabel } },
    );
    return hiding.length > 0 ? (
      <EmptyState
        title="No memos match"
        action={
          <LinkButton href={clearFiltersHref('/memos', params, MEMO_LIST_SPEC)} variant="secondary">
            Clear filters
          </LinkButton>
        }
      >
        Nothing you can open matches {hiding.join(' · ')}.
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

  return (
    <div className={pageStyles.tableCard}>
      <Table caption="Memos, newest first" minWidth={520} className={pageStyles.table ?? ''}>
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
      <div className={pageStyles.tableFooter}>
        <ResultCount shown={page.items.length} total={page.total} noun="memo" />
        {page.nextCursor !== null || cursor !== undefined ? (
          <nav className={pageStyles.pager} aria-label="Memo pages">
            {cursor !== undefined ? (
              <LinkButton href={hrefWith('/memos', params, {})} size="small" variant="ghost">
                Newest memos
              </LinkButton>
            ) : null}
            {page.nextCursor !== null ? (
              <LinkButton
                href={hrefWith('/memos', params, { page: page.nextCursor })}
                size="small"
                variant="tertiary"
              >
                Older memos <Icon name="chevron-right" size={16} />
              </LinkButton>
            ) : null}
          </nav>
        ) : null}
      </div>
    </div>
  );
}

function MemoRow({ memo }: { memo: MemoListItem }) {
  const note = memoRowNote(memo);
  return (
    <tr>
      <Td>
        <div className={pageStyles.memoIdentity}>
          <span className={pageStyles.fileIcon}>
            <Icon name="file-text" size={18} />
          </span>
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
        </div>
      </Td>
      <Td nowrap>
        <MemoStatus status={memo.status} />
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
