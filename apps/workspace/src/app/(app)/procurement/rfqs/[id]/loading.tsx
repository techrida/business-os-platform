import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while an RFQ loads. */
export default function RfqLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Request for quotation" />
      <p className="sr-only" role="status">
        Loading the RFQ
      </p>
      <Card aria-hidden="true">
        <div style={{ display: 'grid', gap: 16 }}>
          <Skeleton height={20} width="40%" />
          <Skeleton height={64} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
