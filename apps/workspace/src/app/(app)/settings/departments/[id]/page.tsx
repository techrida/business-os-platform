import type { AdminDepartmentDetail } from '@bos/contracts';
import type { Metadata } from 'next';
import { notFound } from 'next/navigation';

import { DepartmentActions } from '@/components/departments/department-actions';
import { PeopleCard } from '@/components/departments/people-card';
import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { getDepartment, listActiveStaff, listDepartments } from '@/lib/api-departments';
import { getPermissionCheck } from '@/lib/live-permissions';

import admin from '../../admin.module.css';
import { BackToSettings } from '../../_components/back-link';
import { describeError } from '../../admin-errors';
import { requireSection } from '../../guard';
import { section } from '../../section';

export const metadata: Metadata = { title: 'Department · Business OS' };
export const dynamic = 'force-dynamic';

const PATH = '/settings/departments';

export default async function DepartmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const here = `${PATH}/${encodeURIComponent(id)}`;
  const session = await requireSection('departments', here);
  const canWrite = (await getPermissionCheck(session))('admin.roles.write');

  let detail: AdminDepartmentDetail | null;
  let loadError: string | null = null;
  try {
    detail = await getDepartment(session, id);
  } catch (error) {
    detail = null;
    loadError = describeError(error, 'view departments');
  }
  // Unknown, other-company and not-allowed ids all read as "could not be found" (spec 5.2).
  if (detail === null && loadError === null) notFound();

  if (detail === null) {
    return (
      <Page className={admin.page}>
        <BackToSettings />
        <Breadcrumb items={[{ label: 'Departments', href: PATH }, { label: 'Department' }]} />
        <Alert
          tone="error"
          role="alert"
          actions={
            <LinkButton href={here} variant="secondary" size="small">
              Try again
            </LinkButton>
          }
        >
          {loadError}
        </Alert>
      </Page>
    );
  }

  const [staff, active] = await Promise.all([
    canWrite ? section('list people', () => listActiveStaff(session)) : null,
    canWrite ? section('view departments', () => listDepartments(session)) : null,
  ]);
  const destinations = active?.ok
    ? active.data.items.map(({ id: key, name }) => ({ id: key, name }))
    : [];
  const record = {
    id: detail.id,
    name: detail.name,
    version: detail.version,
    status: detail.status,
    members: detail.memberCount,
  };
  const retired = detail.status === 'retired';

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <Breadcrumb items={[{ label: 'Departments', href: PATH }, { label: detail.name }]} />
      <PageHeader
        title={detail.name}
        status={retired ? <Badge>Retired</Badge> : <Badge tone="success">Active</Badge>}
        actions={
          canWrite ? (
            <DepartmentActions department={record} destinations={destinations} variant="header" />
          ) : null
        }
      />
      {retired ? (
        <Alert tone="info">
          {`${detail.name} is retired. Its past records stay under ${detail.name}.`}
        </Alert>
      ) : !canWrite ? (
        <Alert tone="info">You do not have permission to change departments.</Alert>
      ) : null}
      {staff !== null && !staff.ok && <Alert tone="warning">{staff.message}</Alert>}
      <PeopleCard
        key={detail.revision}
        detail={detail}
        staff={staff?.ok ? staff.data : []}
        destinations={destinations}
        canWrite={canWrite}
      />
    </Page>
  );
}
