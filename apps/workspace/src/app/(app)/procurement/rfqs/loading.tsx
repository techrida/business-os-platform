import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the RFQ list loads. */
export default function RfqsLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Requests for quotation" />
      <p className="sr-only" role="status">
        Loading requests for quotation
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
