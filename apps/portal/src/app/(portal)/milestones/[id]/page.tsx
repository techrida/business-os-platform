import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import styles from '@/components/portal/page.module.css';
import { ApiError } from '@/lib/api';
import { getPortalSalesOrder } from '@/lib/api.billing';
import { displayFormat } from '@/lib/display';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { MilestoneTable } from '../_components/milestone-table';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One confirmed order's milestones for the signed-in customer. A bad id, a 404, a 403, a draft or cancelled order and
 * someone else's order all show the same "Order not found" (not-found.tsx): the customer must not learn whether an
 * order exists.
 */
export default async function OrderMilestonesPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const returnTo = `/auth/login?returnTo=${encodeURIComponent(`/milestones/${id}`)}`;

  const session = await getSession();
  if (!session) redirect(returnTo);

  const display = await getPortalDisplay(session);
  let order;
  try {
    order = await getPortalSalesOrder(session, id);
  } catch (err) {
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    if (err instanceof ApiError && err.status === 401) redirect(returnTo);
    throw err;
  }
  const { money } = displayFormat(display);

  return (
    <main className={styles.main}>
      <p className={styles.back}>
        <Link href="/milestones">← Your milestones</Link>
      </p>
      <div className={styles.head}>
        <h1 className={styles.title}>Order {order.number}</h1>
        <p className={styles.lede}>Order total {money(order.total, order.currency)}</p>
      </div>
      {order.milestones.length === 0 ? (
        <p className={styles.lede}>This order has no milestones.</p>
      ) : (
        <MilestoneTable order={order} display={display} />
      )}
    </main>
  );
}
