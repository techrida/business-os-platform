import { redirect } from 'next/navigation';

import styles from '@/components/portal/page.module.css';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';
import { listPortalInvoices } from '@/lib/api.billing';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { InvoiceList } from './_components/invoice-list';

export const dynamic = 'force-dynamic';

const LOGIN = '/auth/login?returnTo=%2Finvoices';

/**
 * The customer's own issued invoices and notes, as the API returns them. The API lists issued
 * documents of the session's party only, and the strict list schema refuses anything else (a 502,
 * shown by the error page), so a draft can never be listed here.
 */
export default async function InvoicesPage() {
  const session = await getSession();
  if (!session) redirect(LOGIN);

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalInvoices(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect(LOGIN);
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your invoices</h1>
        <p className={styles.lede}>Invoices and notes we have issued to you appear here.</p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No invoices yet" icon="receipt">
          When we issue you an invoice, it will be listed here with its payment status.
        </EmptyState>
      ) : (
        <InvoiceList items={items} display={await display} />
      )}
    </main>
  );
}
