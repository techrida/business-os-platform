import { getMemoDirectory } from '@/lib/api-kernel';
import type { Metadata } from 'next';

import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { requireStaffSession } from '@/lib/bff';

import { createMemoAction } from '../actions';
import { MemoForm } from '../memo-form';

export const metadata: Metadata = { title: 'New memo · Business OS' };

export default async function NewMemoPage() {
  const session = await requireStaffSession('/memos/new');
  const directory = await getMemoDirectory(session);
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: 'New memo' }]} />
      <PageHeader
        title="New memo"
        description="Save it as a draft first. You can attach files and see the approval route before you submit."
      />
      <Panel title="Memo details">
        <MemoForm
          directory={directory}
          action={createMemoAction}
          initial={{ title: '', body: '', amount: '', currency: 'NPR' }}
          submitLabel="Save draft"
          cancelHref="/memos"
        />
      </Panel>
    </Page>
  );
}
