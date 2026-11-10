import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { requireStaffSession } from '@/lib/bff';

import { PlusIcon } from './memo-icons';

export const metadata: Metadata = { title: 'Memos · Business OS' };

export default async function MemosPage() {
  await requireStaffSession('/memos');
  return (
    <Page width="narrow">
      <PageHeader
        title="Memos"
        description="Prepare memos, attach supporting documents and follow approvals."
        actions={
          <LinkButton href="/memos/new">
            <PlusIcon />
            New memo
          </LinkButton>
        }
      />
      <Panel title="Find a memo">
        <p>
          Open an existing memo from its notification or a saved link. New memos open after you save
          them.
        </p>
      </Panel>
    </Page>
  );
}
