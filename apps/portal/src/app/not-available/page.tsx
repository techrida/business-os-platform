import { redirect } from 'next/navigation';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { getSession } from '@/lib/session';

export const dynamic = 'force-dynamic';

/**
 * Reached only when sign-in finds an organisation kind the portal does not serve (it is neither
 * a customer nor a vendor). No session is created for it, so the user can only sign out.
 */
export default async function NotAvailablePage() {
  if (await getSession()) redirect('/');

  return (
    <CenteredPage>
      <NoticeCard
        title="This portal is not available for your account"
        actions={
          <form noValidate method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          This portal is for our customers and vendors, and your account is not one of those. If you
          think this is a mistake, please ask your contact with us to check your account.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
