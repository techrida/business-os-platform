import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * A signed-in user the portal cannot serve yet: the API refused them (403), or their customer
 * account is not linked to a company record. No session exists, so sending them to
 * /auth/login would loop.
 */
export default async function NoAccessPage() {
  if (await getSession()) redirect('/');

  return (
    <CenteredPage>
      <NoticeCard
        title="Your account is not set up yet"
        actions={
          <form method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          You are signed in, but your account is not linked to a customer yet. Please ask your
          contact with us to finish setting up your portal access.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
