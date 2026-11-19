import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import styles from '@/components/portal/page.module.css';
import { ApiError } from '@/lib/api';
import {
  getPortalInvoice,
  getPortalInvoiceSettlement,
  type PortalSettlement,
} from '@/lib/api.billing';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { InvoiceView } from '../_components/invoice-view';

export const dynamic = 'force-dynamic';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * One issued invoice for the signed-in customer. A bad id, a 404, a 403, a draft and someone else's
 * invoice all show the same "Invoice not found" (not-found.tsx): the customer must not learn whether
 * an invoice exists. The invoice and its settlement are fetched together; a 404 on either is "not
 * found". If only the settlement fails otherwise, the invoice still shows, with a notice.
 */
export default async function InvoicePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const returnTo = `/auth/login?returnTo=${encodeURIComponent(`/invoices/${id}`)}`;

  const session = await getSession();
  if (!session) redirect(returnTo);

  const display = getPortalDisplay(session);
  const [invoice, settlement] = await Promise.allSettled([
    getPortalInvoice(session, id),
    getPortalInvoiceSettlement(session, id),
  ]);

  for (const r of [invoice, settlement]) {
    if (r.status !== 'rejected') continue;
    const err: unknown = r.reason;
    if (err instanceof ApiError && (err.status === 404 || err.status === 403)) notFound();
    if (err instanceof ApiError && err.status === 401) redirect(returnTo);
  }
  if (invoice.status === 'rejected') throw invoice.reason;
  const settled: PortalSettlement | null =
    settlement.status === 'fulfilled' ? settlement.value : null;

  return (
    <main className={styles.main}>
      <p className={styles.back}>
        <Link href="/invoices">← Your invoices</Link>
      </p>
      <InvoiceView view={invoice.value} settlement={settled} display={await display} />
    </main>
  );
}
