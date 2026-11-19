import { Card } from '@/components/ui/card';
import { Page, PageHeader } from '@/components/ui/page';
import { Skeleton } from '@/components/ui/panel';

import styles from '../_components/invoice.module.css';

/** Shown while one invoice loads: a document-shaped sheet with a details card beside it, so nothing jumps. */
export default function InvoiceLoading() {
  return (
    <Page aria-busy="true">
      <PageHeader title="Invoice" />
      <p className="sr-only" role="status">
        Loading the invoice
      </p>
      <div className={styles.columns}>
        <div className={styles.detailMain}>
          <Card aria-hidden="true">
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 24 }}>
              <Skeleton height={56} width="40%" />
              <Skeleton height={32} width="30%" />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 32 }}>
              <Skeleton height={20} width="50%" />
              <Skeleton height={20} width="35%" />
            </div>
            <div style={{ display: 'grid', gap: 8, marginTop: 32 }}>
              <Skeleton height={40} />
              <Skeleton height={44} />
              <Skeleton height={44} />
            </div>
            <div style={{ display: 'grid', gap: 12, marginTop: 32, justifyItems: 'end' }}>
              <Skeleton height={20} width="45%" />
              <Skeleton height={20} width="45%" />
              <Skeleton height={44} width="45%" />
            </div>
          </Card>
        </div>
        <div className={styles.side}>
          <Card aria-hidden="true">
            <Skeleton height={20} width="40%" />
            <div style={{ display: 'grid', gap: 20, marginTop: 24 }}>
              <Skeleton height={32} />
              <Skeleton height={32} />
              <Skeleton height={32} />
            </div>
          </Card>
        </div>
      </div>
    </Page>
  );
}
