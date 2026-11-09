import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** Shown while a vendor loads: block-shaped placeholders so the page does not jump. */
export default function VendorLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Vendor" />
      <p className="sr-only" role="status">
        Loading the vendor
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="30%" />
        <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
          <Skeleton height={36} />
          <Skeleton height={36} />
          <Skeleton height={36} width="70%" />
        </div>
      </Card>
      <Card aria-hidden="true">
        <Skeleton height={20} width="20%" />
        <div style={{ display: 'grid', gap: 16, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
        </div>
      </Card>
    </Page>
  );
}
