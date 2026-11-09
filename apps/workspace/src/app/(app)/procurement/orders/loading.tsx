import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the purchase order list loads: row-shaped placeholders so the page does not jump. */
export default function PurchaseOrdersLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Purchase orders" />
      <p className="sr-only" role="status">
        Loading purchase orders
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
