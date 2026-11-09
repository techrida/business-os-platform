import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while a receipts screen loads (the list, one receipt or the new-receipt form): placeholders the shape of a table. */
export default function ReceiptsLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Receipts" />
      <p className="sr-only" role="status">
        Loading receipts
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
