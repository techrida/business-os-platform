import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { RfqView } from '@/components/vendor/rfq-view';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding, getVendorRfq } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { isUuid, loadVendor } from '../../load';

export const dynamic = 'force-dynamic';

/**
 * One request for quotation. A bad id is not-found before any API call, and so is every 404
 * (foreign, closed, unknown): the vendor must not learn whether someone else's request exists.
 * Needs a full vendor account; any other, or a 403, shows the no-access notice.
 */
export default async function RfqPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isUuid(id)) notFound();
  const here = `/vendor/rfqs/${id}`;

  const session = await getSession();
  if (!session) redirect(`/auth/login?returnTo=${encodeURIComponent(here)}`);

  const onboarding = await loadVendor(() => getVendorOnboarding(session), here);
  if (onboarding.kind === 'forbidden') return <VendorNoAccess />;
  if (onboarding.kind === 'missing') notFound();
  if (onboarding.data.capability !== 'full') return <VendorNoAccess />;

  const result = await loadVendor(() => getVendorRfq(session, id), here);
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <p className={pageStyles.back}>
        <Link href="/vendor/rfqs">← Your requests for quotation</Link>
      </p>
      <RfqView view={result.data} now={new Date()} />
    </main>
  );
}
