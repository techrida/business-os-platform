import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while the invoices load: a filter-shaped bar and row-shaped placeholders, so nothing jumps. */
export default function InvoicesLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Invoices" />
      <p className="sr-only" role="status">
        Loading invoices
      </p>
      <Skeleton height={40} width={480} />
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
