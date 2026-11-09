import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while one purchase order loads. */
export default function PurchaseOrderLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Purchase order" />
      <p className="sr-only" role="status">
        Loading the purchase order
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={60} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
