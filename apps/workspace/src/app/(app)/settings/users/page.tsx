import {
  AdminUserSearchSchema,
  AdminUserSortSchema,
  AdminUsersQuerySchema,
  RoleKeySchema,
  UserStatusSchema,
} from '@bos/contracts';
import { z } from 'zod';
import type { Metadata } from 'next';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listUsers, summarizeUsers } from '@/lib/api-admin';

import admin from '../admin.module.css';
import { BackToSettings } from '../_components/back-link';
import { formatInstant } from '../format';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { UsersFilters } from './filters';
import { PasswordReset } from './password-reset';
import { PageSize } from './page-size';
import { roleLabel } from './role-checkboxes';
import { RolesEditor } from './roles-editor';
import styles from './users.module.css';

export const metadata: Metadata = { title: 'Users · Business OS' };

const DEFAULT_SIZE = 50;
const USER_PAGE_SIZES = [5, 10, 25, DEFAULT_SIZE];
type Params = Record<string, string | string[] | undefined>;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const limit = USER_PAGE_SIZES.find((n) => String(n) === params.limit) ?? DEFAULT_SIZE;
  const requestedSort = AdminUserSortSchema.safeParse(params.sort).data;
  const after = requestedSort ? undefined : z.guid().safeParse(params.after).data;
  const sort = after ? undefined : (requestedSort ?? 'name');
  const page = after ? 1 : (AdminUsersQuerySchema.safeParse({ page: params.page }).data?.page ?? 1);
  const q = AdminUserSearchSchema.safeParse(params.q).data || undefined;
  const role = RoleKeySchema.safeParse(params.role).data;
  const status = UserStatusSchema.safeParse(params.status).data;
  const departmentId = z.guid().safeParse(params.departmentId).data;
  const filters = { q, role, status, departmentId, sort, limit };
  const filtered = Boolean(q || role || status || departmentId);

  function href(nextPage = 1, withFilters = true, cursor?: string) {
    const query = new URLSearchParams();
    if (cursor) query.set('after', cursor);
    if (nextPage !== 1) query.set('page', String(nextPage));
    if (limit !== DEFAULT_SIZE) query.set('limit', String(limit));
    if (sort && sort !== 'name') query.set('sort', sort);
    if (withFilters) {
      if (q) query.set('q', q);
      if (role) query.set('role', role);
      if (status) query.set('status', status);
      if (departmentId) query.set('departmentId', departmentId);
    }
    return query.size ? `/settings/users?${query}` : '/settings/users';
  }

  const session = await requireSection('users', href(page, true, after));
  const [users, summary] = await Promise.all([
    section('view users', () =>
      listUsers(session, { ...filters, ...(after ? { after } : { page }) }),
    ),
    section('view user totals', () => summarizeUsers(session)),
  ]);
  const items = users.ok ? users.data.items : [];
  const next = users.ok ? users.data.nextPage : null;
  const nextAfter = users.ok ? users.data.nextAfter : null;
  const clearHref = href(1, false);
  const pastFirstPage = page > 1 || Boolean(after);
  const numberFormat = new Intl.NumberFormat();
  const count = (value: number) => numberFormat.format(value);
  const add = (
    <LinkButton href="/settings/users/new" size="large">
      <span aria-hidden="true">＋</span>Add user
    </LinkButton>
  );

  return (
    <Page className={admin.page}>
      <BackToSettings />
      <PageHeader
        title="Users"
        description="Invite colleagues and manage their access."
        actions={add}
      />
      {!users.ok ? (
        <SectionError message={users.message} />
      ) : (
        <>
          {summary.ok ? (
            <div className={styles.stats}>
              <StatCard label="Total users" value={count(summary.data.total)} icon="users" />
              <StatCard
                label="Active users"
                value={count(summary.data.active)}
                icon="check-circle"
                tone="success"
              />
              <StatCard
                label="Invited users"
                value={count(summary.data.invited)}
                icon="inbox"
                tone="warning"
              />
              <StatCard
                label="Inactive users"
                value={count(summary.data.deactivated)}
                icon="user"
                tone="neutral"
              />
            </div>
          ) : (
            <SectionError message={summary.message} />
          )}
          <UsersFilters
            filters={filters}
            departments={summary.ok ? summary.data.departments : []}
            clearHref={filtered ? clearHref : undefined}
          />
          <div className={styles.results}>
            {items.length === 0 ? (
              <EmptyState
                icon="users"
                title={
                  pastFirstPage ? 'No more users' : filtered ? 'No matching users' : 'No users yet'
                }
                action={
                  pastFirstPage ? (
                    <LinkButton href={href()} variant="secondary">
                      Back to the first page
                    </LinkButton>
                  ) : filtered ? (
                    <LinkButton href={clearHref} variant="secondary">
                      Clear filters
                    </LinkButton>
                  ) : (
                    add
                  )
                }
              >
                {pastFirstPage
                  ? 'You have reached the end of the list.'
                  : filtered
                    ? 'Try another name, email or filter.'
                    : 'Invite the first person to give them access.'}
              </EmptyState>
            ) : (
              <Table
                caption="Users and their roles"
                minWidth={800}
                stickyFirstColumn
                className={`${admin.local} ${styles.directory}`}
              >
                <thead>
                  <tr>
                    <Th aria-sort={sort === 'name' ? 'ascending' : undefined}>User</Th>
                    <Th>Department</Th>
                    <Th>Roles</Th>
                    <Th aria-sort={sort === 'lastActive' ? 'descending' : undefined}>
                      Last active
                    </Th>
                    <Th>Status</Th>
                    <Th align="end">Actions</Th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((user, index) => {
                    const label =
                      [user.displayName, user.email].filter(Boolean).join(' · ') ||
                      `unnamed user ${index + 1}`;
                    return (
                      <tr key={user.id}>
                        <Th scope="row" className={admin.rowHead}>
                          <div className={styles.person}>
                            <Avatar name={user.displayName ?? user.email ?? ''} shape="circle" />
                            <span className={styles.personText}>
                              <span className={styles.name}>
                                {user.displayName ?? 'No name yet'}
                              </span>
                              {user.email && <span className={styles.email}>{user.email}</span>}
                            </span>
                          </div>
                        </Th>
                        <Td className={styles.department}>
                          {user.department?.name ?? (
                            <>
                              <span aria-hidden="true">—</span>
                              <span className="sr-only">No department</span>
                            </>
                          )}
                        </Td>
                        <Td>
                          {user.roles.length ? (
                            <ul className={styles.roles}>
                              {user.roles.map((r) => (
                                <li key={r}>
                                  <Badge>{roleLabel(r)}</Badge>
                                </li>
                              ))}
                            </ul>
                          ) : (
                            <span className={styles.muted}>No roles</span>
                          )}
                        </Td>
                        <Td nowrap>
                          {user.lastActiveAt ? (
                            <time dateTime={user.lastActiveAt}>
                              {formatInstant(user.lastActiveAt)}
                            </time>
                          ) : (
                            <span className={styles.muted}>Never</span>
                          )}
                        </Td>
                        <Td>
                          <Badge
                            tone={
                              user.status === 'active'
                                ? 'success'
                                : user.status === 'invited'
                                  ? 'pending'
                                  : 'neutral'
                            }
                            className={styles.status ?? ''}
                          >
                            {user.status}
                          </Badge>
                        </Td>
                        <Td align="end">
                          <div className={styles.rowActions}>
                            <RolesEditor userId={user.id} label={label} roles={user.roles} />
                            {summary.ok &&
                              summary.data.canSendPasswordReset &&
                              user.email &&
                              user.status === 'active' && (
                                <PasswordReset userId={user.id} label={label} email={user.email} />
                              )}
                          </div>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </Table>
            )}
            <div className={styles.resultsFooter}>
              <Pagination
                label="Users pages"
                summary={
                  <span role="status">
                    {items.length === 0
                      ? '0 users'
                      : after
                        ? `${count(items.length)} ${items.length === 1 ? 'user' : 'users'}`
                        : `Showing ${count((page - 1) * limit + 1)}–${count((page - 1) * limit + items.length)}${!filtered && summary.ok ? ` of ${count(summary.data.total)}` : ''}`}
                  </span>
                }
                {...(pastFirstPage ? { previousHref: href(after ? 1 : page - 1) } : {})}
                {...(next
                  ? { nextHref: href(next) }
                  : nextAfter
                    ? { nextHref: href(1, true, nextAfter) }
                    : {})}
              />
              <PageSize sizes={USER_PAGE_SIZES} size={limit} filters={filters} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
