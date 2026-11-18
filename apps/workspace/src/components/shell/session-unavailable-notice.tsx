'use client';

import { NoticeCard } from '@/components/shell/notice-card';
import { Button } from '@/components/ui/button';
import { CenteredPage } from '@/components/ui/centered-page';

/**
 * Shown by an error boundary when the session store did not answer (SessionUnavailableError).
 * The user is still signed in: the cookie was kept and nothing was cleared. Retry re-renders the
 * page from the server (a fresh GET); it never repeats a form submission or server action.
 */
export function SessionUnavailableNotice({ retry }: { retry: () => void }) {
  return (
    <CenteredPage>
      <NoticeCard
        title="Session check temporarily unavailable"
        actions={<Button onClick={() => retry()}>Retry</Button>}
      >
        <p role="alert">We could not confirm your sign-in just now. Retry in a moment.</p>
      </NoticeCard>
    </CenteredPage>
  );
}
