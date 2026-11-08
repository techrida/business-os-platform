import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while a memo loads: the two-column shape, so the page does not jump when it arrives. */
export default function MemoLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Memo" />
      <p className="sr-only" role="status">
        Loading the memo
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
