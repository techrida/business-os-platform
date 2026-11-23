import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/** What a customer sees on the link of a quotation the company cancelled: a plain notice, not "not found". */
export function QuotationClosed() {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Quotation no longer open</h1>
      </div>
      <EmptyState
        title="This quotation is no longer open"
        icon="file-text"
        action={<LinkButton href="/">Your quotations</LinkButton>}
      >
        The company has withdrawn it, so it can no longer be accepted. Contact them if you have a
        question.
      </EmptyState>
    </main>
  );
}
