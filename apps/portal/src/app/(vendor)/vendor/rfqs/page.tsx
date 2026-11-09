import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { RfqList } from '@/components/vendor/rfq-list';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, listVendorRfqs } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { loadVendor } from '../load';

export const dynamic = 'force-dynamic';

const HERE = '/vendor/rfqs';

/**
 * The requests for quotation the vendor is invited to. Needs a full vendor account: any other
 * gets the no-access notice before the list is read, and a 403 from the API shows the same notice.
 */
export default async function RfqsPage() {
  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(HERE)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), HERE);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  const result = await loadVendor(() => listVendorRfqs(session), HERE);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Requests for quotation</h1>
        <p className={pageStyles.lede}>
          Requests we have invited you to price. Open one to see the items and send your quotation
          before it closes.
        </p>
      </div>
      <RfqList items={result.data} now={new Date()} />
    </main>
  );
}
