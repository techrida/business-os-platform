import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getFooterLinks } from '@/lib/env';
import { getSession } from '@/lib/session';

export default async function StaffOnlyPage() {
  const session = await getSession();
  if (!session) redirect('/auth/login?returnTo=%2Fstaff-only');
  // Staff who land here by typing the URL belong in the workspace.
  if (session.orgKind === 'staff') redirect('/');

  return (
    <CenteredPage width="split">
      <NoticeCard
        footerLinks={getFooterLinks()}
        title="This is the staff workspace"
        actions={
          <form noValidate method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          Your account is signed in, but it does not have access to this area. It is meant for our
          own team. If you think you should have access, please contact your account manager.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
