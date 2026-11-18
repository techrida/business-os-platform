import type { ReactNode } from 'react';

import { Alert } from '@/components/ui/alert';
import { PageHeader } from '@/components/ui/page';

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

/** The page's `h1` with a one-line description. Render it inside the page's `Page`. */
export function PageHead({ title, children }: { title: string; children?: ReactNode }) {
  return <PageHeader title={title} description={children} />;
}

/** Shown in place of a section's content when its request failed (for example a 403). */
export function SectionError({ message }: { message: string }) {
  return <Notice kind="error">{message}</Notice>;
}
