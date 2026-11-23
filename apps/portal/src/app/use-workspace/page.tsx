import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button, LinkButton } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getEnv } from '@/lib/env';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Staff who signed in to the portal. The callback gives them no session, so this renders without
 * one. Sign out posts to /auth/logout, which ends the ZITADEL session.
 */
export default async function UseWorkspacePage() {
  if (await getSession()) redirect('/');
  const workspaceUrl = getEnv().WORKSPACE_PUBLIC_URL;

  return (
    <CenteredPage>
      <NoticeCard
        title="Use the Workspace instead"
        actions={
          <>
            {workspaceUrl ? <LinkButton href={workspaceUrl}>Open the Workspace</LinkButton> : null}
            <form noValidate method="post" action="/auth/logout">
              <Button type="submit" variant={workspaceUrl ? 'secondary' : 'primary'}>
                Sign out
              </Button>
            </form>
          </>
        }
      >
        <p>
          This portal is for customers. Your account belongs to our staff, so please sign in to the
          Workspace to see quotations and customers.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
