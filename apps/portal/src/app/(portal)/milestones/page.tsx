import { redirect } from 'next/navigation';

import styles from '@/components/portal/page.module.css';
import { EmptyState } from '@/components/ui/empty-state';
import { ApiError } from '@/lib/api';
import { listPortalSalesOrders } from '@/lib/api.billing';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { OrderList } from './_components/order-list';

export const dynamic = 'force-dynamic';

const LOGIN = '/auth/login?returnTo=%2Fmilestones';

/**
 * The customer's confirmed orders, each with its milestones (the order's billing schedule, F1-Q34). The API lists
 * only the session party's confirmed and completed orders, and the strict schema refuses anything else (a 502, shown
 * by the error page).
 */
export default async function MilestonesPage() {
  const session = await getSession();
  if (!session) redirect(LOGIN);

  const display = getPortalDisplay(session);
  let items;
  try {
    items = await listPortalSalesOrders(session);
  } catch (err) {
    if (err instanceof ApiError && err.status === 401) redirect(LOGIN);
    if (err instanceof ApiError && err.status === 403) redirect('/no-access');
    throw err;
  }

  return (
    <main className={styles.main}>
      <div className={styles.head}>
        <h1 className={styles.title}>Your milestones</h1>
        <p className={styles.lede}>
          Each confirmed order is billed in milestones. Open an order to see them.
        </p>
      </div>
      {items.length === 0 ? (
        <EmptyState title="No orders yet" icon="list-checks">
          When you accept a quotation and we confirm the order, its milestones appear here.
        </EmptyState>
      ) : (
        <OrderList items={items} display={await display} />
      )}
    </main>
  );
}
