import type { Metadata } from 'next';

import { Breadcrumb, Page } from '@/components/ui/page';

import { requireSession } from '../../guard';
import { InviteForm } from '../invite-form';

export const metadata: Metadata = { title: 'Invite user · Business OS' };

export default async function InviteUserPage() {
  await requireSession('/admin/users/new');
  return (
    <Page>
      <Breadcrumb items={[{ label: 'Users', href: '/admin/users' }, { label: 'Invite user' }]} />
      <InviteForm />
    </Page>
  );
}
