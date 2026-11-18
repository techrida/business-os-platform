import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the customer list loads: row-shaped placeholders so the page does not jump. */
export default function CustomersLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Organizations" />
      <p className="sr-only" role="status">
        Loading organizations
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
