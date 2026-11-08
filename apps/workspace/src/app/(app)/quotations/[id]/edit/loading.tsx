import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** The builder's two-column shape while the opportunity and lookups load, so nothing jumps. */
export default function EditQuotationLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Edit quotation" />
      <p className="sr-only" role="status">
        Loading the quotation
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={120} />
        </div>
      </Card>
    </Page>
  );
}
