import type { ReactNode } from 'react';

import styles from './admin.module.css';
import type { ActionState } from './action-state';

// Tiny presentational pieces shared by the admin pages. No hooks, so Server and Client Components
// can both use them.

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'ok';
  children: ReactNode;
}) {
  const tone =
    kind === 'error' ? styles.noticeError : kind === 'ok' ? styles.noticeOk : styles.noticeInfo;
  return (
    <div className={`${styles.notice} ${tone}`}>
      <p>{children}</p>
    </div>
  );
}

export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <header className={styles.pageHead}>
      <h1>{title}</h1>
      {children ? <p className={styles.lede}>{children}</p> : null}
    </header>
  );
}

/** Result of a Server Action, announced to screen readers when it changes. */
export function FormStatus({ state, pending }: { state: ActionState; pending: boolean }) {
  if (pending) {
    return (
      <p className={styles.status} role="status">
        Saving...
      </p>
    );
  }
  if (state.status === 'idle') return null;
  const isError = state.status === 'error';
  return (
    <p
      className={`${styles.status} ${isError ? styles.statusError : styles.statusOk}`}
      role={isError ? 'alert' : 'status'}
    >
      {state.message}
    </p>
  );
}

/** Shown in place of a section's content when its request failed (for example a 403). */
export function SectionError({ message }: { message: string }) {
  return <Notice kind="error">{message}</Notice>;
}
