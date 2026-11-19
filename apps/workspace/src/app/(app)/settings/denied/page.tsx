import type { Metadata } from 'next';

import { EmptyState } from '@/components/ui/empty-state';
import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { requireSession } from '../guard';

export const metadata: Metadata = { title: 'Settings' };

// Where a person lands when they open Settings without a role that opens any section. It checks
// the session only: there is no permission to hold, and it must not redirect again.
export default async function SettingsDeniedPage() {
  await requireSession('/settings/denied');
  return (
    <Page>
      <PageHeader title="Settings" />
      <EmptyState
        title="You don't have access to Settings"
        action={<LinkButton href="/">Back to overview</LinkButton>}
      >
        <p>Ask the Founder if you need something changed.</p>
      </EmptyState>
    </Page>
  );
}
