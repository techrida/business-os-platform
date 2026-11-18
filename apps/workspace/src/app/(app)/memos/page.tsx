import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { MEMO_STATUS_FILTERS, safeCursor } from '@/lib/memo-list-view';

import { MemoStatusFilter } from './memo-status-filter';
import { MemoList, MemoListSkeleton } from './memo-list';
import { PlusIcon } from './memo-icons';
import styles from './memo-pages.module.css';

export const metadata: Metadata = { title: 'Memos · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<{ cursor?: string | string[]; status?: string | string[] }>;

export default async function MemosPage({ searchParams }: { searchParams: SearchParams }) {
  await requireStaffSession('/memos');
  const query = await searchParams;
  const cursor = safeCursor(query.cursor);
  const status = typeof query.status === 'string' ? query.status : undefined;
  const active = MEMO_STATUS_FILTERS.find((f) => f.value === status)?.value;
  return (
    <Page>
      <PageHeader
        title="Memos"
        description="Create memos, continue drafts and track approvals."
        actions={
          <LinkButton href="/memos/new" size="large">
            <PlusIcon />
            New memo
          </LinkButton>
        }
      />
      <div className={styles.results}>
        <MemoStatusFilter active={active} />
        <Suspense key={`${cursor ?? ''}|${active ?? ''}`} fallback={<MemoListSkeleton />}>
          <MemoList cursor={cursor} status={active} />
        </Suspense>
      </div>
    </Page>
  );
}
