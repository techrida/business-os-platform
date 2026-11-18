import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

import layout from '@/components/p3/list.module.css';

/** Shown while the sales orders load: a filter-shaped bar and row-shaped placeholders, so nothing jumps. */
export default function SalesOrdersLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Sales orders" />
      <p className="sr-only" role="status">
        Loading sales orders
      </p>
      <div className={layout.stats} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <Skeleton key={i} height={124} />
        ))}
      </div>
      <Skeleton height={40} width={240} />
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
