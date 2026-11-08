import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { getSession } from '@/lib/session';

import styles from './shell.module.css';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    // A server layout cannot see the URL without a proxy, and in P0 this group only holds `/`.
    // When P1 adds more pages here, send each page's own path (pages can call redirect too).
    redirect('/auth/login?returnTo=%2F');
  }
  // The API is the authority on org kind (it came from /v1/me at login). Customer and vendor
  // users have a valid session but no business here.
  if (session.orgKind !== 'staff') redirect('/staff-only');

  return (
    <div className={styles.frame}>
      <header className={styles.header}>
        <p className={styles.brand}>Business OS</p>
        <div className={styles.who}>
          <span className={styles.badge}>{session.orgKind}</span>
          <span className={styles.roles}>
            {session.roles.length > 0 ? session.roles.join(', ') : 'No roles'}
          </span>
          {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
          <form method="post" action="/auth/logout">
            <button type="submit" className={styles.button}>
              Sign out
            </button>
          </form>
        </div>
      </header>
      {children}
    </div>
  );
}
