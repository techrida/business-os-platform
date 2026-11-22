import styles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';

/** True for the API's answer to the link of a sent quotation that was cancelled (409 `quotation_closed`). */
export function isQuotationClosed(err: unknown): boolean {
  if (!(err instanceof ApiError) || err.status !== 409) return false;
  const body = err.body as { error?: { code?: unknown } } | null | undefined;
  return body?.error?.code === 'quotation_closed';
}

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
