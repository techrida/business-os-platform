import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { PurchaseOrderView } from '@/components/vendor/po-view';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, getVendorPurchaseOrder } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { isUuid, loadVendor } from '../../load';

export const dynamic = 'force-dynamic';

/**
 * One purchase order. A bad id and a 404 (foreign, draft, unknown) show the same "Page not found":
 * the vendor must not learn whether someone else's order exists. The API filters by the token's
 * vendor; the strict view schema is the second wall. Submit a bill needs full access, read from
 * the onboarding view like the bills page: if that read fails the link is hidden and the order
 * still shows.
 */
export default async function PurchaseOrderPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const here = `/vendor/purchase-orders/${id}`;

  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(here)}`);

  const display = getPortalDisplay(session);
  const [result, capability] = await Promise.all([
    loadVendor(() => getVendorPurchaseOrder(session, id), here),
    getVendorOnboarding(session).then(
      (view) => view.capability,
      () => null,
    ),
  ]);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <p className={pageStyles.back}>
        <Link href="/vendor/purchase-orders">← Your purchase orders</Link>
      </p>
      <PurchaseOrderView view={result.data} display={await display} capability={capability} />
    </main>
  );
}
