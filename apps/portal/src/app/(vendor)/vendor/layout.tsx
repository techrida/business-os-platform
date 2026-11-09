import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { TopBar } from '@/components/portal/top-bar';
import { VendorNoAccess } from '@/components/vendor/vendor-no-access';
import { getVendorOnboarding } from '@/lib/api.vendor';
import { getSession } from '@/lib/session';

import { loadVendor } from './load';

export const dynamic = 'force-dynamic';

/**
 * Signed-in vendor pages, in their own route group so the customer layout (and its quotations
 * landing page) never wraps them. The vendor's live status decides what the top bar offers
 * (`capability`): the API is the authority, so a 403 here, from a caller that is not a vendor with
 * a party, shows the no-access notice in place and renders none of the pages. A server layout
 * cannot see the URL, so each page that needs to come back to itself after sign-in redirects with
 * its own returnTo.
 */
export default async function VendorLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2Fvendor');

  const onboarding = await loadVendor(() => getVendorOnboarding(session), '/vendor');
  if (onboarding.kind !== 'ok') return <VendorNoAccess />;

  return (
    <>
      <TopBar kind="vendor" capability={onboarding.data.capability} />
      {children}
    </>
  );
}
