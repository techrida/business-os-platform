import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while one quotation loads: a facts-shaped card and a totals-shaped card, so nothing jumps. */
export default function QuotationLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Quotation" />
      <p className="sr-only" role="status">
        Loading the quotation
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
        </div>
      </Card>
    </Page>
  );
}
