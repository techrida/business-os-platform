import { redirect } from 'next/navigation';
import type { ReactNode } from 'react';

import { accountLabel } from '@/components/shell/account-label';
import { Header } from '@/components/shell/header';
import { ShellFrame, ShellMain } from '@/components/shell/shell-state';
import { Sidebar } from '@/components/shell/sidebar';
import { NumberSystemProvider } from '@/components/ui/number-system-context';
import { WebVitals } from '@/components/web-vitals';
import { getMe } from '@/lib/api';
import { getNumberSystems } from '@/lib/display-settings';
import { getSession, type Session } from '@/lib/session';

/**
 * The signed-in person's picture from `/v1/me`. Never throws: a failed read shows initials, it never breaks the shell.
 * The person's `app.users.id` is not in `/v1/me` yet (its `userId` is the identity provider's subject), so the
 * sidebar cannot offer the profile picture upload until it is.
 */
async function ownAvatar(session: Session): Promise<string | null> {
  try {
    return (await getMe(session)).avatarDocumentId ?? null;
  } catch {
    return null;
  }
}

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
  // Neither throws: a failed read falls back to the default grouping and to initials.
  const [numberSystems, avatarDocumentId] = await Promise.all([
    getNumberSystems(),
    ownAvatar(session),
  ]);

  return (
    <ShellFrame>
      {/* Only signed-in staff report vitals: /telemetry/vitals needs a session. */}
      <WebVitals />
      <Sidebar
        user={{ name: roles, detail: session.orgKind, imageDocumentId: avatarDocumentId }}
        roles={session.roles}
      />
      <ShellMain>
        <Header orgKind={session.orgKind} roles={session.roles} />
        <NumberSystemProvider value={numberSystems}>{children}</NumberSystemProvider>
      </ShellMain>
    </ShellFrame>
  );
}
