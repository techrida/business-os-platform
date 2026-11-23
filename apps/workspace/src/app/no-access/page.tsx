import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getFooterLinks } from '@/lib/env';
import { getSession } from '@/lib/session';

/**
 * Staff who signed in but hold no project role (CR-02). Lives outside the `(app)` group so it
 * renders without the shell.
 *
 * It must also render without a session: the API refuses role-less staff, so a login can fail
 * before a session exists. Sending those visitors to /auth/login would loop.
 */
export default async function NoAccessPage() {
  const session = await getSession();
  if (session?.orgKind === 'staff' && session.roles.length > 0) redirect('/');
  if (session && session.orgKind !== 'staff') redirect('/staff-only');

  return (
    <CenteredPage width="split">
      <NoticeCard
        footerLinks={getFooterLinks()}
        title="You don't have access yet"
        actions={
          <form noValidate method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          Your account is signed in, but it has not been given a role yet. An administrator must
          grant you a role before you can use the workspace.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
