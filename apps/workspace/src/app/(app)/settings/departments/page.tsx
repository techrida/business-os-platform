import {
  DEPARTMENT_STATUSES,
  DepartmentStatusSchema,
  type AdminDepartmentItem,
} from '@bos/contracts';
import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import Link from 'next/link';

import {
  DepartmentActions,
  NewDepartmentButton,
} from '@/components/departments/department-actions';
import { DepartmentFilters } from '@/components/departments/department-filters';
import styles from '@/components/departments/departments.module.css';
import { Alert } from '@/components/ui/alert';
import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { listActiveStaff, listDepartments } from '@/lib/api-departments';
import { hrefWith, readList, type RawParams } from '@/lib/list-params';
import { getPermissionCheck } from '@/lib/live-permissions';

import admin from '../admin.module.css';
import { BackToSettings } from '../_components/back-link';
import { requireSection } from '../guard';
import { section } from '../section';

export const metadata: Metadata = { title: 'Departments · Business OS' };

const PATH = '/settings/departments';
const SPEC = { multi: { status: DEPARTMENT_STATUSES } } as const;
const numberFormat = new Intl.NumberFormat();

const count = (value: number, one: string, many: string) =>
  `${numberFormat.format(value)} ${value === 1 ? one : many}`;

function StatusBadge({ status }: { status: AdminDepartmentItem['status'] }) {
  return status === 'active' ? <Badge tone="success">Active</Badge> : <Badge>Retired</Badge>;
}

function HeadCell({ head }: { head: AdminDepartmentItem['head'] }) {
  if (head === null) return <span className={styles.muted}>No head</span>;
  return (
    <span className={styles.person}>
      <Avatar name={head.name} size="small" shape="circle" />
      <span className={styles.name}>{head.name}</span>
    </span>
  );
}

export default async function DepartmentsPage({
  searchParams,
}: {
  searchParams: Promise<RawParams>;
}) {
  const params = await searchParams;
  const state = readList(params, SPEC);
  const q = state.q;
  const statuses = DepartmentStatusSchema.array().parse(state.multi.status);
  const here = hrefWith(PATH, params, {});

  const session = await requireSection('departments', here);
  // The live saved grants (Settings > Access), not the role defaults: granting it opens the actions at once.
  const canWrite = (await getPermissionCheck(session))('admin.roles.write');
  const [list, staff, active] = await Promise.all([
    section('view departments', () => listDepartments(session, { q, status: statuses })),
    canWrite ? section('list people', () => listActiveStaff(session)) : null,
    canWrite ? section('view departments', () => listDepartments(session)) : null,
  ]);
  const staffChoices = staff?.ok ? staff.data : [];
  const destinations = active?.ok ? active.data.items.map(({ id, name }) => ({ id, name })) : [];
  const newButton = canWrite ? <NewDepartmentButton staff={staffChoices} /> : null;

  const record = (item: AdminDepartmentItem) => ({
    id: item.id,
    name: item.name,
    version: item.version,
    status: item.status,
    members: item.members,
  });
  const actionsFor = (item: AdminDepartmentItem) =>
    canWrite ? (
      <DepartmentActions department={record(item)} destinations={destinations} variant="row" />
    ) : null;

  let body: ReactNode;
  let trulyEmpty = false;
  if (!list.ok) {
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
        {list.message}
      </Alert>
    );
  } else {
    const { items, unassigned } = list.data;
    const onlyRetired = statuses.length === 1 && statuses[0] === 'retired';
    const unassignedHref = `${PATH}/unassigned`;
    trulyEmpty = items.length === 0 && q === undefined && !onlyRetired;
    const empty =
      q !== undefined ? (
        <EmptyState
          icon="search"
          title={`No department matches '${q}'.`}
          action={
            <LinkButton href={hrefWith(PATH, params, { q: undefined })} variant="secondary">
              Clear search
            </LinkButton>
          }
        />
      ) : onlyRetired ? (
        <EmptyState icon="building" title="No retired departments." />
      ) : (
        <EmptyState icon="building" title="No departments yet." action={newButton}>
          Add your first department, then add its people.
        </EmptyState>
      );

    body = (
      <>
        <p className="sr-only" role="status">
          {count(items.length, 'department', 'departments')}
        </p>
        {items.length === 0 ? (
          empty
        ) : (
          <div className={styles.results}>
            <div className={styles.wide}>
              <table className={styles.table}>
                <caption className="sr-only">Departments</caption>
                <thead>
                  <tr>
                    <th scope="col">Department</th>
                    <th scope="col">Head</th>
                    <th scope="col" className={styles.end}>
                      Managers
                    </th>
                    <th scope="col" className={styles.end}>
                      Members
                    </th>
                    <th scope="col">Status</th>
                    {canWrite && (
                      <th scope="col" className={styles.end}>
                        Actions
                      </th>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.id}>
                      <th scope="row">
                        <Link href={`${PATH}/${item.id}`} className={styles.link}>
                          {item.name}
                        </Link>
                      </th>
                      <td>
                        <HeadCell head={item.head} />
                      </td>
                      <td className={styles.end}>{numberFormat.format(item.managers)}</td>
                      <td className={styles.end}>{numberFormat.format(item.members)}</td>
                      <td>
                        <StatusBadge status={item.status} />
                      </td>
                      {canWrite && <td className={styles.end}>{actionsFor(item)}</td>}
                    </tr>
                  ))}
                  {unassigned > 0 && (
                    <tr className={styles.unassigned}>
                      <th scope="row">
                        <Link href={unassignedHref} className={styles.link}>
                          No department
                        </Link>
                      </th>
                      <td colSpan={canWrite ? 5 : 4}>{count(unassigned, 'person', 'people')}</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <ul className={`${styles.narrow} ${styles.cardList}`} aria-label="Departments">
              {items.map((item) => (
                <li key={item.id} className={styles.cardItem}>
                  <div className={styles.cardTop}>
                    <Link href={`${PATH}/${item.id}`} className={styles.link}>
                      {item.name}
                    </Link>
                    <StatusBadge status={item.status} />
                    {actionsFor(item)}
                  </div>
                  <p className={styles.cardMeta}>
                    {item.head === null ? 'No head' : `Head: ${item.head.name}`}
                  </p>
                  <p className={styles.cardMeta}>
                    {count(item.managers, 'manager', 'managers')} ·{' '}
                    {count(item.members, 'member', 'members')}
                  </p>
                </li>
              ))}
              {unassigned > 0 && (
                <li className={styles.cardItem}>
                  <Link href={unassignedHref} className={styles.link}>
                    No department
                  </Link>
                  <p className={styles.cardMeta}>{count(unassigned, 'person', 'people')}</p>
                </li>
              )}
            </ul>
          </div>
        )}
      </>
    );
  }

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Departments"
        description="Who works in each department. A person's level decides how much of the department's work they see."
        actions={trulyEmpty ? null : newButton}
      />
      {list.ok && <DepartmentFilters statuses={statuses} />}
      {body}
    </Page>
  );
}
