'use client';

import { SessionUnavailableNotice } from '@/components/shell/session-unavailable-notice';
import { isSessionUnavailable } from '@/lib/session-unavailable';
import styles from '@/components/portal/page.module.css';
import { Button } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';

/**
 * A portal page failed on the server. Nothing from the error is shown: its message can carry
 * internal detail. Next passes only a digest to the client in production anyway.
 */
export default function PortalError({
  error,
  reset,
  retry,
}: {
  error: unknown;
  retry: () => void;
  reset: () => void;
}) {
  if (isSessionUnavailable(error)) return <SessionUnavailableNotice retry={retry} />;
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
        Please try again. If it keeps happening, contact the person who sent you the quotation.
      </EmptyState>
    </main>
  );
}
