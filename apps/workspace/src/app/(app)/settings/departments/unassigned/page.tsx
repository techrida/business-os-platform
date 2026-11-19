import type { Metadata } from 'next';
import type { ReactNode } from 'react';

import { AddToDepartment } from '@/components/departments/add-to-department';
import styles from '@/components/departments/departments.module.css';
import { permissionChecker } from '@/components/p2/customers/permissions';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { FilterBar } from '@/components/ui/filter-bar';
import { Breadcrumb, Page, PageHeader } from '@/components/ui/page';
import { listDepartments, listUnassignedPeople } from '@/lib/api-departments';
import { hrefWith, readList, type RawParams } from '@/lib/list-params';

import admin from '../../admin.module.css';
import { BackToSettings } from '../../_components/back-link';
import { requireSection } from '../../guard';
import { section } from '../../section';
import { roleLabel } from '../../users/role-checkboxes';

export const metadata: Metadata = { title: 'No department · Business OS' };

const PATH = '/settings/departments/unassigned';

/** Active staff who belong to no department, each with "Add to department" (spec 5.1). */
export default async function UnassignedPeoplePage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const { q } = readList(params, {});
  const here = hrefWith(PATH, params, {});
  const session = await requireSection('departments', here);
  const canWrite = permissionChecker(session.roles)('admin.roles.write');
  const [people, active] = await Promise.all([
    section('view departments', () => listUnassignedPeople(session, q)),
    canWrite ? section('view departments', () => listDepartments(session)) : null,
  ]);
  const departments = active?.ok ? active.data.items.map(({ id, name }) => ({ id, name })) : [];

  let body: ReactNode;
  if (!people.ok) {
    body = (
      <Alert
        tone="error"
        role="alert"
        actions={
          <LinkButton href={here} variant="secondary" size="small">
            Try again
          </LinkButton>
        }
      >
        {people.message}
      </Alert>
    );
  } else if (people.data.items.length === 0) {
    body =
      q !== undefined ? (
        <EmptyState
          icon="search"
          title={`No one matches '${q}'.`}
          action={
            <LinkButton href={hrefWith(PATH, params, { q: undefined })} variant="secondary">
              Clear search
            </LinkButton>
          }
        />
      ) : (
        <EmptyState icon="users" title="Everyone is in a department." />
      );
  } else {
    body = (
      <ul className={`${styles.results} ${styles.cardList}`} aria-label="People with no department">
        {people.data.items.map((person) => (
          <li key={person.userId} className={styles.cardItem}>
            <div className={styles.cardTop}>
              <span className={styles.person}>
                <Avatar name={person.name} size="small" shape="circle" />
                <span className={styles.personText}>
                  <span className={styles.name}>{person.name}</span>
                  {person.email && <span className={styles.email}>{person.email}</span>}
                </span>
              </span>
              {canWrite && (
                <AddToDepartment
                  person={{ id: person.userId, name: person.name }}
                  departments={departments}
                />
              )}
            </div>
            {person.roles.length > 0 && (
              <ul className={styles.roles} aria-label={`Roles of ${person.name}`}>
                {person.roles.map((role) => (
                  <li key={role}>
                    <Badge>{roleLabel(role)}</Badge>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    );
  }

  const total = people.ok ? people.data.total : null;
  return (
    <Page className={admin.page}>
      <BackToSettings />
      <Breadcrumb
        items={[
          { label: 'Departments', href: '/settings/departments' },
          { label: 'No department' },
        ]}
      />
      <PageHeader
        title="No department"
        description="Active people who are not in any department yet."
      />
      <FilterBar search={{ label: 'Search people', placeholder: 'Search name or email' }} />
      {total !== null && (
        <p className="sr-only" role="status">
          {total === 1 ? '1 person' : `${total} people`}
        </p>
      )}
      {body}
    </Page>
  );
}
