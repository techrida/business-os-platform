import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { accountLabel } from '@/components/shell/account-label';
import { Header } from '@/components/shell/header';
import { ShellFrame, ShellMain } from '@/components/shell/shell-state';
import { Sidebar } from '@/components/shell/sidebar';
import { WebVitals } from '@/components/web-vitals';
import { getSession } from '@/lib/session';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const session = await getSession();
  if (!session) {
    // A server layout cannot see the URL without a proxy, and in P0 this group only holds `/`.
    // When P1 adds more pages here, send each page's own path (pages can call redirect too).
    redirect('/auth/login?returnTo=%2F');
  }
  // The API is the authority on org kind (it came from /v1/me at login). Customer and vendor
  // users have a valid session but no business here.
  if (session.orgKind !== 'staff') redirect('/staff-only');
  // Being in the staff org is not enough (CR-02): self-registration could put anyone there. The
  // API refuses role-less staff too; this keeps them out of the shell.
  if (session.roles.length === 0) redirect('/no-access');

  const roles = accountLabel(session.roles);

  return (
    <ShellFrame>
      {/* Only signed-in staff report vitals: /telemetry/vitals needs a session. */}
      <WebVitals />
      <Sidebar user={{ name: roles, detail: session.orgKind }} roles={session.roles} />
      <ShellMain>
        <Header orgKind={session.orgKind} roles={session.roles} />
        {children}
      </ShellMain>
    </ShellFrame>
  );
}
