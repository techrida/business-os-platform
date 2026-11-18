import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

/** The form's shape while the customers load, so nothing jumps. */
export default function NewPaymentLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Record payment" />
      <p className="sr-only" role="status">
        Loading the payment form
      </p>
      <Card aria-hidden="true">
        <Skeleton height={20} width="40%" />
        <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={44} />
          <Skeleton height={120} />
        </div>
      </Card>
    </Page>
  );
}
