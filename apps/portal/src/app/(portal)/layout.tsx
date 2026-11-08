import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { TopBar } from '@/components/portal/top-bar';
import { getSession } from '@/lib/session';

/**
 * Signed-in customer pages. getSession() returns a session only for a customer user with a party
 * (session.ts enforces it on every read), so no further kind check is needed here. Without one,
 * the visitor signs in. A server layout cannot see the URL, so each page that needs to come back
 * to itself after sign-in redirects with its own returnTo (PT2).
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2F');

  return (
    <>
      <TopBar />
      {children}
    </>
  );
}
