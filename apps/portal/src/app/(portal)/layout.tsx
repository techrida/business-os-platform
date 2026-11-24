import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { TopBar } from '@/components/portal/top-bar';
import { getBranding, logoSrc } from '@/lib/api-branding';
import { getSession } from '@/lib/session';

/**
 * Signed-in customer pages. getSession() returns a session only for a customer or vendor user with
 * a party (session.ts enforces it on every read). Anything but a customer session goes to the
 * vendor screens, whose layout refuses anything but a vendor, so neither kind sees the other's
 * pages. Without a session, the visitor signs in. A server layout cannot see the URL, so each page
 * that needs to come back to itself after sign-in redirects with its own returnTo (PT2).
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2F');
  if (session.orgKind !== 'customer') redirect('/vendor');

  const branding = await getBranding(session);

  return (
    <>
      <TopBar brand={{ name: branding?.displayName ?? null, logoSrc: logoSrc(branding) }} />
      {children}
    </>
  );
}
