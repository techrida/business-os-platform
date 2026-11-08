import { redirect } from 'next/navigation';

import { getSession } from '@/lib/session';
import styles from '../(app)/shell.module.css';

export default async function StaffOnlyPage() {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2Fstaff-only');
  // Staff who land here by typing the URL belong in the workspace.
  if (session.orgKind === 'staff') redirect('/');

  return (
    <div className={`${styles.frame} ${styles.centered}`}>
      <main className={styles.card}>
        <h1>This is the staff workspace</h1>
        <p>
          Your account is signed in, but it does not have access to this area. It is meant for our
          own team. If you think you should have access, please contact your account manager.
        </p>
        <form method="post" action="/auth/logout">
          <button type="submit" className={styles.button}>
            Sign out
          </button>
        </form>
      </main>
    </div>
  );
}
