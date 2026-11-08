import type { Metadata } from 'next';

import { LinkButton } from '@/components/ui/button';
import { Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { requireStaffSession } from '@/lib/bff';

import { PlusIcon } from './memo-icons';
import { OpenMemoForm } from './open-memo-form';

export const metadata: Metadata = { title: 'Memos · Business OS' };

export default async function MemosPage() {
  await requireStaffSession('/memos');
  return (
    <Page width="narrow">
      <PageHeader
        title="Memos"
        description="Test memos that exercise numbering, attachments, approvals and the audit trail."
        actions={
          <LinkButton href="/memos/new">
            <PlusIcon />
            New memo
          </LinkButton>
        }
      />
      <Panel
        title="Open a memo"
        description="A memo you created opens right after you save it. To come back to one, use the link in its notification, or paste its id here."
      >
        <OpenMemoForm />
      </Panel>
    </Page>
  );
}
