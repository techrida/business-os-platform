import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while a statement loads: the header and panel shapes, so nothing jumps. */
export default function CustomerStatementLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Customer statement" />
      <p className="sr-only" role="status">
        Loading the statement
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
      <Card aria-hidden="true">
        <Skeleton height={20} width="25%" />
        <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
          <Skeleton height={36} />
        </div>
      </Card>
    </Page>
  );
}
