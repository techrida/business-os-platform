import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * The same answer for a bad id, someone else's quotation and one not sent yet, so the page never
 * says whether a quotation exists.
 */
export default function QuotationNotFound() {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Quotation not found</h1>
      </div>
      <EmptyState
        title="We could not find that quotation"
        icon="file-text"
        action={<LinkButton href="/">Your quotations</LinkButton>}
      >
        Check the link you followed, or open your quotations to find it.
      </EmptyState>
    </main>
  );
}
