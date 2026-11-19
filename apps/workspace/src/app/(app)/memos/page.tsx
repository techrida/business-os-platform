import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { readList, type RawParams } from '@/lib/list-params';

import { MemoFilters } from './memo-filters';
import { cursorOf, MEMO_LIST_SPEC } from './memo-list-params';
import { MemoList, MemoListSkeleton } from './memo-list';
import { PlusIcon } from './memo-icons';
import styles from './memo-pages.module.css';

export const metadata: Metadata = { title: 'Memos · Business OS' };
export const dynamic = 'force-dynamic';

type SearchParams = Promise<RawParams>;

export default async function MemosPage({ searchParams }: { searchParams: SearchParams }) {
  await requireStaffSession('/memos');
  const params = await searchParams;
  const { q, multi } = readList(params, MEMO_LIST_SPEC);
  const cursor = cursorOf(params);
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
        <MemoFilters status={multi.status} />
        <Suspense
          key={`${cursor ?? ''}|${multi.status.join(',')}|${q ?? ''}`}
          fallback={<MemoListSkeleton />}
        >
          <MemoList params={params} />
        </Suspense>
      </div>
    </Page>
  );
}
