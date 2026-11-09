import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';

/**
 * The no-access notice for a signed-in vendor the API refused (403). Rendered in place, not by a
 * redirect to /no-access: that page sends anyone who has a session back to `/`, and the vendor
 * pages would bounce between the two. Its Sign out posts to /auth/logout like the original.
 */
export function VendorNoAccess() {
  return (
    <CenteredPage>
      <NoticeCard
        title="Your vendor account cannot use this page"
        actions={
          <form method="post" action="/auth/logout">
            <Button type="submit">Sign out</Button>
          </form>
        }
      >
        <p>
          You are signed in, but your account is not set up for this part of the vendor portal.
          Please ask the person you work with at our company to check your access.
        </p>
      </NoticeCard>
    </CenteredPage>
  );
}
