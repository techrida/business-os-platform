import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/** Vendor users who signed in. Their portal comes later (P4); they get no session here. */
export default async function NotAvailablePage() {
  if (await getSession()) redirect('/');

  return (
    <CenteredPage>
      <NoticeCard
        title="Not available yet"
        actions={
          <form method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          This portal is for customers. A portal for suppliers is not available yet. Your contact
          with us will tell you when it opens.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
