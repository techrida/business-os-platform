import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { BillList } from '@/components/vendor/bill-list';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { listVendorBills } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/bills';

/** The vendor's bills with a coarse status: matching and approval steps stay private. */
export default async function BillsPage() {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const result = await loadVendor(() => listVendorBills(session), HERE);
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
      <BillList items={result.data} />
    </main>
  );
}
