import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page';

import styles from './admin.module.css';
import type { ActionState } from './action-state';

// Tiny presentational pieces shared by the admin pages. No hooks, so Server and Client Components
// can both use them. They sit on the shared components (Alert, PageHeader); the names and props
// stay as the pages already call them.

export function Notice({
  kind = 'info',
  children,
}: {
  kind?: 'info' | 'error' | 'ok';
  children: ReactNode;
}) {
  return <Alert tone={kind === 'ok' ? 'success' : kind}>{children}</Alert>;
}

/** The page's `h1` with a one-line description. Render it inside the page's `Page`. */
export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return <PageHeader title={title} description={children} />;
}

/** Result of a Server Action, announced to screen readers when it changes. */
export function FormStatus({ state, pending }: { state: ActionState; pending: boolean }) {
  if (pending) {
    return (
      <p className={`${styles.status} ${styles.muted}`} role="status">
        Saving...
      </p>
    );
  }
  if (state.status === 'idle') return null;
  const isError = state.status === 'error';
  return (
    <Alert tone={isError ? 'error' : 'success'} role={isError ? 'alert' : 'status'}>
      {/* Messages can carry line breaks (a list of field problems). */}
      <span className={styles.status}>{state.message}</span>
    </Alert>
  );
}

/** Shown in place of a section's content when its request failed (for example a 403). */
export function SectionError({ message }: { message: string }) {
  return <Notice kind="error">{message}</Notice>;
}
