'use client';

import styles from '@/components/portal/page.module.css';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * A vendor page failed on the server. Nothing from the error is shown: its message can carry
 * internal detail. Next passes only a digest to the client in production anyway.
 */
export default function VendorError({
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Something went wrong</h1>
      </div>
      <EmptyState
        title="We could not load this page"
        icon="alert-triangle"
        action={<Button onClick={reset}>Try again</Button>}
      >
        Please try again. If it keeps happening, contact the person you work with at our company.
      </EmptyState>
    </main>
  );
}
