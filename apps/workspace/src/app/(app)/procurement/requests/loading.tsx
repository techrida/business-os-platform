import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the purchase request list loads. */
export default function PurchaseRequestsLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Purchase requests" />
      <p className="sr-only" role="status">
        Loading purchase requests
      </p>
      <Card aria-hidden="true">
        <div style={{ display: 'grid', gap: 16 }}>
          <Skeleton height={20} width="30%" />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
