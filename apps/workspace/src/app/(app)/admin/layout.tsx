import type { ReactNode } from 'react';

// Wraps every /admin page. It renders no `main` (each page's `Page` does) and holds no session
// check on purpose: pages and actions run their own (see guard.ts), because a layout does not
// protect the pages rendered beside it. The sidebar carries the admin navigation.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
