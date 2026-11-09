import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while one sales order loads: a facts-shaped card and a table-shaped card, so nothing jumps. */
export default function SalesOrderLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Sales order" />
      <p className="sr-only" role="status">
        Loading the sales order
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={32} />
          <Skeleton height={32} />
          <Skeleton height={32} />
        </div>
      </Card>
    </Page>
  );
}
