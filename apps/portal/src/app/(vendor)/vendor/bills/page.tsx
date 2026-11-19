import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { LinkButton } from '@/components/ui/button';
import { BillList } from '@/components/vendor/bill-list';
import vendorStyles from '@/components/vendor/vendor.module.css';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, listVendorBills } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/bills';

/**
 * The vendor's bills with a coarse status: matching and approval steps stay private. Only a vendor
 * with full access gets the Submit a bill link. That comes from the onboarding read, which is an
 * extra: if it fails for any reason the link is hidden and the list still shows.
 */
export default async function BillsPage() {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const display = getPortalDisplay(session);
  const [result, capability] = await Promise.all([
    loadVendor(() => listVendorBills(session), HERE),
    getVendorOnboarding(session).then(
      (view) => view.capability,
      () => null,
    ),
  ]);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Your bills</h1>
        <p className={pageStyles.lede}>
          Bills we have received from you and where each one stands.
        </p>
      </div>
      <div className={vendorStyles.section}>
        {capability === 'full' ? (
          <div className={vendorStyles.download}>
            <LinkButton href="/vendor/bills/new">Submit a bill</LinkButton>
          </div>
        ) : null}
        <BillList items={result.data} display={await display} />
      </div>
    </main>
  );
}
