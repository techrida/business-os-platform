import type { ReactNode } from 'react';

import styles from './admin.module.css';
import { AdminNav } from './admin-nav';

// Wraps every /admin page. It holds no session check on purpose: pages and actions run their own
// (see guard.ts), because a layout does not protect the pages rendered beside it.
export default function AdminLayout({ children }: { children: ReactNode }) {
  return (
    <div className={styles.shell}>
      <AdminNav />
      <main className={styles.main} id="main">
        {children}
      </main>
    </div>
  );
}
