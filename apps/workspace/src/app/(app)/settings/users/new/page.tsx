import type { Metadata } from 'next';

import { Breadcrumb, Page } from '@/components/ui/page';
import { listDepartments } from '@/lib/api-departments';
import { getPermissionCheck } from '@/lib/live-permissions';
import type { Session } from '@/lib/session';

import admin from '../../admin.module.css';
import { requireSection } from '../../guard';
import { InviteForm } from '../invite-form';

export const metadata: Metadata = { title: 'Add New User · Business OS' };

/**
 * The active departments to place a new person in, or null when the fields stay hidden: placing people needs
 * `admin.roles.write` (the API checks it again), and a failed read leaves the invite usable without them.
 */
async function placementDepartments(
  session: Session,
): Promise<{ id: string; name: string }[] | null> {
  if (!(await getPermissionCheck(session))('admin.roles.write')) return null;
  try {
    const { items } = await listDepartments(session, { status: ['active'] });
    return items.map(({ id, name }) => ({ id, name }));
  } catch {
    return null;
  }
}

export default async function InviteUserPage() {
  const session = await requireSection('users', '/settings/users/new');
  const departments = await placementDepartments(session);
  return (
    <Page className={admin.page}>
      <Breadcrumb
        items={[{ label: 'Users', href: '/settings/users' }, { label: 'Add New User' }]}
      />
      <InviteForm departments={departments} />
    </Page>
  );
}
