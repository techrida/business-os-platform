import type { MeResponse } from '@bos/contracts';
import { redirect } from 'next/navigation';

import { getMe } from '@/lib/api';
import { getSession } from '@/lib/session';

import styles from './shell.module.css';

export default async function ShellPage() {
  // Layouts and pages render in parallel, so the layout's check does not protect this page.
  // The page asks for the session itself (it needs the access token for /v1/me anyway).
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2F');

  // `redirect` throws, so it stays outside the try block.
  let me: MeResponse | null = null;
  try {
    me = await getMe(session);
  } catch {
    me = null;
  }

  if (!me) {
    return (
      <main className={styles.main}>
        <section className={`${styles.card} ${styles.alert}`} role="alert">
          <h1>We could not reach the platform API</h1>
          <p>You are signed in, but your profile did not load. Reload the page in a moment.</p>
        </section>
      </main>
    );
  }

  return (
    <main className={styles.main}>
      <section className={styles.card} aria-labelledby="ready-heading">
        <h1 id="ready-heading">P0: platform ready</h1>
        <p>You are signed in. These values come straight from the API for this request.</p>
        <dl className={styles.facts}>
          <dt>User</dt>
          <dd>{me.userId}</dd>
          <dt>Tenant</dt>
          <dd>{me.tenantId}</dd>
          <dt>Organisation</dt>
          <dd>{me.organizationId}</dd>
          <dt>Correlation ID</dt>
          <dd>{me.correlationId}</dd>
        </dl>
      </section>
    </main>
  );
}
