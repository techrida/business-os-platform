import styles from '@/components/portal/page.module.css';
import { EmptyState } from '@/components/ui/empty-state';

export const dynamic = 'force-dynamic';

/** Landing page. PT2 fills it with the customer's issued quotations. */
export default function QuotationsPage() {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your quotations</h1>
        <p className={styles.lede}>Quotations we have sent you appear here.</p>
      </div>
      <EmptyState title="No quotations yet" icon="file-text">
        When we send you a quotation, it will be listed here for you to review.
      </EmptyState>
    </main>
  );
}
