import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The same answer for a bad id, someone else's invoice, a draft and an unknown id, so the page
 * never says whether an invoice exists.
 */
export default function InvoiceNotFound() {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Invoice not found</h1>
      </div>
      <EmptyState
        title="We could not find that invoice"
        icon="receipt"
        action={<LinkButton href="/invoices">Your invoices</LinkButton>}
      >
        Check the link you followed, or open your invoices to find it.
      </EmptyState>
    </main>
  );
}
