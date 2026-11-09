import { redirect } from 'next/navigation';

import { getSession } from '@/lib/session';

import styles from './shell.module.css';

export default async function ShellPage() {
  // Layouts and pages render in parallel, so the layout's check does not protect this page.
  // The page asks for the session itself.
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2F');

  // No time-of-day greeting: the server cannot know the user's time zone.
  return (
    <main className={styles.main}>
      <div className={styles.pageHead}>
        <h1 className={styles.pageTitle}>Welcome back</h1>
        <p className={styles.pageLede}>Nothing needs your attention right now.</p>
      </div>
    </main>
  );
}
