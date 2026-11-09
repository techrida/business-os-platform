import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the payments load: a filter-shaped bar and row-shaped placeholders, so nothing jumps. */
export default function PaymentsLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Payments" />
      <p className="sr-only" role="status">
        Loading payments
      </p>
      <Skeleton height={40} width={240} />
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
