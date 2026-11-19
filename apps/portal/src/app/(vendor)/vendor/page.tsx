import { notFound, redirect } from 'next/navigation';

import pageStyles from '@/components/portal/page.module.css';
import { OnboardingView } from '@/components/vendor/onboarding-view';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding } from '@/lib/api.vendor';
import { getPortalDisplay } from '@/lib/portal-display';
import { getSession } from '@/lib/session';

import { loadVendor } from './load';

export const dynamic = 'force-dynamic';

/** Landing page: where the vendor's account stands and the onboarding checklist. */
export default async function VendorHomePage() {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2Fvendor');

  const display = getPortalDisplay(session);
  const result = await loadVendor(() => getVendorOnboarding(session), '/vendor');
  if (result.kind === 'forbidden') return <VendorNoAccess />;
  if (result.kind === 'missing') notFound();

  return (
    <main className={pageStyles.main}>
      <div className={pageStyles.head}>
        <h1 className={pageStyles.title}>Your account</h1>
        <p className={pageStyles.lede}>Your onboarding progress and the documents we need.</p>
      </div>
      <OnboardingView view={result.data} display={await display} />
    </main>
  );
}
