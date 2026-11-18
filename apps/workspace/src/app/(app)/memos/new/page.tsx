import type { Metadata } from 'next';

import { Alert } from '@/components/ui/alert';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { Panel } from '@/components/ui/panel';
import { failureOf, getMemoDirectory } from '@/lib/api-kernel';
import { requireStaffSession } from '@/lib/bff';
import { memoDraftAccount } from '@/lib/memo-working-draft';

import { createMemoAction } from '../actions';
import { MemoForm } from '../memo-form';

export const metadata: Metadata = { title: 'New memo · Business OS' };

export default async function NewMemoPage() {
  const session = await requireStaffSession('/memos/new');
  let directory;
  try {
    directory = await getMemoDirectory(session);
  } catch (error) {
    const forbidden = failureOf(error).status === 403;
    return (
      <Page>
        <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: 'New memo' }]} />
        <PageHeader title="New memo" />
        <Alert
          tone="error"
          role="alert"
          title={forbidden ? 'You cannot create a memo' : 'The memo form did not load'}
          actions={
            <a href={forbidden ? '/memos' : '/memos/new'}>
              {forbidden ? 'Back to memos' : 'Try again'}
            </a>
          }
        >
          {forbidden ? 'Your account can open memos it has permission to view.' : null}
        </Alert>
      </Page>
    );
  }
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Memos', href: '/memos' }, { label: 'New memo' }]} />
      <PageHeader
        title="New memo"
        description="Your draft saves as you type. Next saves the memo and shows the approval route before you submit."
      />
      <Panel title="Memo details">
        <MemoForm
          directory={directory}
          action={createMemoAction}
          initial={{ title: '', body: '' }}
          submitLabel="Next"
          draftAccount={memoDraftAccount(session)}
        />
      </Panel>
    </Page>
  );
}
