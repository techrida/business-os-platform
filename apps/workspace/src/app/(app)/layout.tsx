import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { accountLabel } from '@/components/shell/account-label';
import { Header } from '@/components/shell/header';
import { ShellCountsProvider } from '@/components/shell/shell-counts';
import { ShellFrame, ShellMain } from '@/components/shell/shell-state';
import { Sidebar } from '@/components/shell/sidebar';
import { NumberSystemProvider } from '@/components/ui/number-system-context';
import { WebVitals } from '@/components/web-vitals';
import { getBranding, logoSrc } from '@/lib/api-branding';
import { getNumberSystems } from '@/lib/display-settings';
import { getMeOrNull, permissionsFrom } from '@/lib/live-permissions';
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
  // None throws: a failed read falls back to the default grouping, to initials and to the role defaults for the
  // nav. The badge numbers are not read here: the page does not wait for them, and `ShellCountsProvider` reads
  // them once on arrival. Until it has an answer there is no badge, never a zero.
  const [numberSystems, me, branding] = await Promise.all([
    getNumberSystems(),
    getMeOrNull(session.accessToken),
    // The company's name and logo for the sidebar; null (the product name) when it cannot be read.
    getBranding(session),
  ]);

  // The person's name leads the user card with their roles under it; without a name the roles lead, as before.
  const displayName = me?.displayName?.trim() || null;

  return (
    <ShellFrame>
      {/* Only signed-in staff report vitals: /telemetry/vitals needs a session. */}
      <WebVitals />
      {/* One counts poll per tab feeds the sidebar's Inbox badge and the header bell. It reads both numbers once
          on arrival, after the page is on screen. */}
      <ShellCountsProvider>
        <Sidebar
          user={{
            name: displayName ?? roles,
            detail: displayName !== null ? roles : session.orgKind,
            imageDocumentId: me?.avatarDocumentId ?? null,
            ...(me?.id ? { id: me.id } : {}),
          }}
          brand={{ name: branding?.displayName ?? null, logoSrc: logoSrc(branding) }}
          permissions={permissionsFrom(me, session.roles)}
        />
        <ShellMain>
          <Header roles={session.roles} />
          <NumberSystemProvider value={numberSystems}>{children}</NumberSystemProvider>
        </ShellMain>
      </ShellCountsProvider>
    </ShellFrame>
  );
}
