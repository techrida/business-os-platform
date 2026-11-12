import type { Metadata } from 'next';
import { Suspense } from 'react';

import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { requireStaffSession } from '@/lib/bff';
import { MEMO_STATUS_FILTERS, safeCursor } from '@/lib/memo-list-view';

import { MemoStatusFilter } from './memo-status-filter';
import { MemoList, MemoListSkeleton } from './memo-list';
import { PlusIcon } from './memo-icons';

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
        description="The memos you can open, newest first."
        actions={
          <LinkButton href="/memos/new">
            <PlusIcon />
            New memo
          </LinkButton>
        }
      />
      <MemoStatusFilter active={active} />
      {/* The header stays put while a page loads; the key restarts the fallback when the page or filter changes. */}
      <Suspense key={`${cursor ?? ''}|${active ?? ''}`} fallback={<MemoListSkeleton />}>
        <MemoList cursor={cursor} status={active} />
      </Suspense>
    </Page>
  );
}
