import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the aging report loads: a table-shaped card, so nothing jumps. */
export default function ReceivablesAgingLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Receivables aging" />
      <p className="sr-only" role="status">
        Loading the aging report
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
