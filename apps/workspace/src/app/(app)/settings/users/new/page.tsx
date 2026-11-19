import type { Metadata } from 'next';

import { Breadcrumb, Page } from '@/components/ui/page';

import admin from '../../admin.module.css';
import { requireSection } from '../../guard';
import { InviteForm } from '../invite-form';

export const metadata: Metadata = { title: 'Add New User · Business OS' };

export default async function InviteUserPage() {
  await requireSection('users', '/settings/users/new');
  return (
    <Page className={admin.page}>
      <Breadcrumb
        items={[{ label: 'Users', href: '/settings/users' }, { label: 'Add New User' }]}
      />
      <InviteForm />
    </Page>
  );
}
