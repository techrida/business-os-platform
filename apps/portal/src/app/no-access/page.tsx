import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';

export const dynamic = 'force-dynamic';

/**
 * A signed-in user the portal cannot serve yet: the API refused them (403), or their customer or
 * vendor account is not linked to a company record. It renders for everyone, with or without a
 * portal session: sending them to /auth/login would loop when there is none, and sending a
 * session holder to `/` would loop too (a refused customer lands back here, a vendor bounces via
 * /vendor). Its Sign out ends the ZITADEL session, so the user can sign in as someone else.
 */
export default function NoAccessPage() {
  return (
    <CenteredPage>
      <NoticeCard
        title="Your account is not set up yet"
        actions={
          <form noValidate method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          You are signed in, but your account is not linked to a company record yet. Please ask your
          contact with us to finish setting up your portal access.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
