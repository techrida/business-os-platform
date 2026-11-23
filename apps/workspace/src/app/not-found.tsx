import { NoticeCard } from '@/components/shell/notice-card';
import { CenteredPage } from '@/components/ui/centered-page';
import { LinkButton } from '@/components/ui/button';
import { getFooterLinks } from '@/lib/env';

/**
 * Unknown address. Without this file Next serves its own 404, which follows the system theme and
 * renders black for a device that prefers dark; this one stays in the light-only layout.
 */
export default function NotFound() {
  return (
    <CenteredPage>
      <NoticeCard
        footerLinks={getFooterLinks()}
        title="Page not found"
        actions={<LinkButton href="/">Go to the start page</LinkButton>}
      >
        <p>This address does not exist, or you no longer have access to it.</p>
      </NoticeCard>
    </CenteredPage>
  );
}
