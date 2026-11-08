import type { MeResponse } from '@bos/contracts';
import { redirect } from 'next/navigation';

import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
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
        <Card as="section" tone="error" role="alert">
          <h1 className={styles.heading}>We could not reach the platform API</h1>
          <p className={styles.lede}>
            You are signed in, but your profile did not load. Reload the page in a moment.
          </p>
        </Card>
      </main>
    );
  }

  const facts: ReadonlyArray<readonly [string, string]> = [
    ['User', me.userId],
    ['Tenant', me.tenantId],
    ['Organisation', me.organizationId],
    ['Correlation ID', me.correlationId],
  ];

  return (
    <main className={styles.main}>
      <Card as="section" aria-labelledby="ready-heading">
        <div className={styles.head}>
          <div className={styles.headText}>
            <h1 id="ready-heading" className={styles.heading}>
              P0: platform ready
            </h1>
            <p className={styles.lede}>
              You are signed in. These values come straight from the API for this request.
            </p>
          </div>
          <Badge tone="success">API connected</Badge>
        </div>
        <dl className={styles.facts}>
          {facts.map(([term, value]) => (
            <div key={term} className={styles.fact}>
              <dt className={styles.term}>{term}</dt>
              <dd className={styles.value}>{value}</dd>
            </div>
          ))}
        </dl>
      </Card>
    </main>
  );
}
