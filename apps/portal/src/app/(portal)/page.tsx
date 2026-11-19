import { redirect } from 'next/navigation';

import styles from '@/components/portal/page.module.css';
import { QuotationList } from '@/components/portal/quotation-list';
import { todayInKathmandu } from '@/components/portal/quotation-status';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError, listPortalQuotations } from '@/lib/api';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Landing page: the customer's own quotations, newest first as the API orders them. A vendor who
 * opens `/` is sent on to /vendor, never to /no-access. The API
 * returns only customer-visible states for the session's party, and the strict list schema
 * refuses anything else (a 502, shown by error.tsx), so a draft can never be listed here.
 */
export default async function QuotationsPage() {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2F');
  if (session.orgKind !== 'customer') redirect('/vendor');

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalQuotations(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect('/auth/login?returnTo=%2F');
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your quotations</h1>
        <p className={styles.lede}>Quotations we have sent you appear here.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No quotations yet" icon="file-text">
          When we send you a quotation, it will be listed here for you to review.
        </EmptyState>
      ) : (
        <QuotationList items={items} today={todayInKathmandu()} display={await display} />
      )}
    </main>
  );
}
