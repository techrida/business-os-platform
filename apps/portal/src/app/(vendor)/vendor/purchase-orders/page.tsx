import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { PurchaseOrderList } from '@/components/vendor/po-list';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { listVendorPurchaseOrders } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/purchase-orders';

/**
 * The vendor's purchase orders, issued versions only. A vendor who may only onboard gets a 403
 * from the API, shown as the in-place no-access notice (the top bar already hides this link).
 */
export default async function PurchaseOrdersPage() {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const display = getPortalDisplay(session);
  const result = await loadVendor(() => listVendorPurchaseOrders(session), HERE);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Your purchase orders</h1>
        <p className={pageStyles.lede}>Orders we have issued to you, at their latest version.</p>
      </div>
      <PurchaseOrderList items={result.data} display={await display} />
    </main>
  );
}
