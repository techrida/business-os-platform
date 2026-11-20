import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';

export { FormStatus } from './form-status';

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

/** Shown in place of a section's content when its request failed (for example a 403). */
export function SectionError({ message }: { message: string }) {
  return <Notice kind="error">{message}</Notice>;
}
