import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while one invoice loads: a facts-shaped card and a totals-shaped card, so nothing jumps. */
export default function InvoiceLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Invoice" />
      <p className="sr-only" role="status">
        Loading the invoice
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
