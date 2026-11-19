import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { BillView } from '@/components/vendor/bill-view';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorBill } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { isUuid, loadVendor } from '../../load';

export const dynamic = 'force-dynamic';

/** One bill. A bad id and a 404 (foreign, hidden, unknown) show the same "Page not found". */
export default async function BillPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const here = `/vendor/bills/${id}`;

  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(here)}`);

  const display = getPortalDisplay(session);
  const result = await loadVendor(() => getVendorBill(session, id), here);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <p className={pageStyles.back}>
        <Link href="/vendor/bills">← Your bills</Link>
      </p>
      <BillView view={result.data} display={await display} />
    </main>
  );
}
