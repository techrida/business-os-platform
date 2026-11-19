import type { ReactNode } from 'react';

// /admin only holds redirects to /settings (the pages moved there). No chrome, no session check:
// nothing here renders content.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return children;
}
