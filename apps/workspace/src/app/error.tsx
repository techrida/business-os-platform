'use client';

import { SessionUnavailableNotice } from '@/components/shell/session-unavailable-notice';
import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';
import { isSessionUnavailable } from '@/lib/session-unavailable';

/**
 * Boundary for everything under the root layout, including the `(app)` layout's own session
 * check (a segment's error.tsx never wraps its own layout). A session store outage gets its own
 * retryable notice, never a redirect to login; anything else gets a plain retry.
 */
export default function RootError({ error, retry }: { error: unknown; retry: () => void }) {
  if (isSessionUnavailable(error)) return <SessionUnavailableNotice retry={retry} />;
  return (
    <CenteredPage>
      <NoticeCard
        title="This page did not open"
        actions={<Button onClick={() => retry()}>Try again</Button>}
      >
        <p role="alert">Something went wrong on our side. Try again in a moment.</p>
      </NoticeCard>
    </CenteredPage>
  );
}
