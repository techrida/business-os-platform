import {
  ADMIN_USERS_MAX_PAGE,
  AdminUserSortSchema,
  RoleKeySchema,
  ROLE_KEYS,
  UserStatusSchema,
  type AdminUser,
  type AdminUsersQuery,
} from '@bos/contracts';
import type { Metadata } from 'next';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listFlaggedUsers, listUsers, summarizeUsers } from '@/lib/api-admin';
import {
  activeFilterLabels,
  clearFiltersHref,
  hrefWith,
  readList,
  type RawParams,
} from '@/lib/list-params';
import { getMeOrNull, getPermissionCheck } from '@/lib/live-permissions';

import admin from '../admin.module.css';
import { BackToSettings } from '../_components/back-link';
import { formatInstant } from '../format';
import { requireSection } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { UsersFilters } from './filters';
import { PasswordReset } from './password-reset';
import { PageSize } from './page-size';
import { PictureEditor } from './picture-editor';
import { roleLabel } from './role-checkboxes';
import { RolesEditor } from './roles-editor';
import { StatusAction, type StatusActionKind } from './status-actions';
import styles from './users.module.css';

export const metadata: Metadata = { title: 'Users · Business OS' };

const PATH = '/settings/users';
const DEFAULT_SIZE = 50;
const USER_PAGE_SIZES = [5, 10, 25, DEFAULT_SIZE];
const PAGE_LINKS = 5;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Sort is a view choice, not a filter: it stays out of the filter spec so Clear filters keeps it.
const FILTERS = { multi: { status: UserStatusSchema.options, role: ROLE_KEYS } } as const;
const SPEC = {
  multi: FILTERS.multi,
  single: { departmentId: GUID, sort: AdminUserSortSchema.options },
  rows: { allowed: USER_PAGE_SIZES, default: DEFAULT_SIZE },
} as const;

const STATUS_LABELS: Record<AdminUser['status'], string> = {
  active: 'Active',
  invited: 'Invited',
  inactive: 'Deactivated',
};

/**
 * The account actions a row offers (F1-Q5, F1-Q4): an active person can be locked or deactivated; a locked person
 * unlocked (ZITADEL holds them LOCKED, so reactivate would not fit) or deactivated, and one locked after failed
 * sign-ins also kept locked for good; a deactivated person reactivated; an open invite nothing.
 */
function statusActions(user: AdminUser): StatusActionKind[] {
  if (user.lockReason === 'failed_sign_ins') return ['unlock', 'keepLocked', 'deactivate'];
  if (user.lockReason) return ['unlock', 'deactivate'];
  if (user.status === 'active') return ['lock', 'deactivate'];
  if (user.status === 'inactive') return ['reactivate'];
  return [];
}

/** Up to five page numbers around the current one. */
function pageNumbers(current: number, count: number): number[] {
  const last = Math.min(count, ADMIN_USERS_MAX_PAGE);
  const start = Math.max(1, Math.min(current - 2, last - PAGE_LINKS + 1));
  const end = Math.min(last, start + PAGE_LINKS - 1);
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

export default async function UsersPage({ searchParams }: { searchParams: Promise<RawParams> }) {
  const params = await searchParams;
  const state = readList(params, SPEC);
  const { q, rows: limit } = state;
  const page = Math.min(state.page, ADMIN_USERS_MAX_PAGE);
  const statuses = UserStatusSchema.array().parse(state.multi.status);
  const roles = RoleKeySchema.array().parse(state.multi.role);
  const { departmentId } = state.single;
  const sort = AdminUserSortSchema.safeParse(state.single.sort).data ?? 'name';
  const filtered = Boolean(q || statuses.length || roles.length || departmentId);

  // A cursor from an older link would skip rows once a filter changes, so it never carries over.
  const href = (nextPage: number) =>
    hrefWith(PATH, params, { page: nextPage === 1 ? undefined : nextPage, after: undefined });
  const clearHref = clearFiltersHref(PATH, params, { ...FILTERS, single: { departmentId: GUID } });
  const query: Partial<AdminUsersQuery> = { limit, page, sort };
  if (q) query.q = q;
  if (statuses.length) query.status = statuses;
  if (roles.length) query.role = roles;
  if (departmentId) query.departmentId = departmentId;

  const session = await requireSection('users', href(page));
  // "Check access" opens Settings > Access, which needs the access read permission.
  const canCheckAccess = (await getPermissionCheck(session))('admin.roles.read');
  const [users, summary, me] = await Promise.all([
    section('view users', () => listUsers(session, query)),
    section('view user totals', () => summarizeUsers(session)),
    getMeOrNull(session.accessToken),
  ]);
  // F1-Q5: account actions need the company-wide grant (the summary says so); never on the caller's own row, and
  // only when the caller's own row is known, since the API refuses it anyway.
  const canChangeStatus = summary.ok && summary.data.canChangeStatus === true && Boolean(me?.id);
  // FU8: the link to the flagged people shows only to a caller who can resolve them, with how many wait.
  const flagged = canChangeStatus
    ? await section('view flagged users', () => listFlaggedUsers(session))
    : null;
  const flaggedCount = flagged?.ok ? flagged.data.items.length : 0;
  const items = users.ok ? users.data.items : [];
  const next = users.ok ? users.data.nextPage : null;
  const departments = summary.ok ? summary.data.departments : [];
  const activeFilters = activeFilterLabels(
    { q, multi: { status: statuses, role: roles }, single: { departmentId } },
    {
      status: { label: 'Status', format: (v) => v.charAt(0).toUpperCase() + v.slice(1) },
      role: { label: 'Role', format: roleLabel },
      departmentId: {
        label: 'Department',
        format: (id) => departments.find((d) => d.id === id)?.name ?? 'Unavailable department',
      },
    },
  );
  const pastFirstPage = page > 1;
  const numberFormat = new Intl.NumberFormat();
  const count = (value: number) => numberFormat.format(value);
  // All matches of the filters and search; the tenant figure only stands in when the list sent none.
  const total =
    (users.ok ? users.data.total : null) ?? (!filtered && summary.ok ? summary.data.total : null);
  const pageLinks =
    total === null
      ? []
      : pageNumbers(page, Math.ceil(total / limit)).map((n) => ({ page: n, href: href(n) }));
  const review = canChangeStatus && flagged?.ok && (
    <LinkButton href="/settings/users/flagged" variant="secondary" size="large">
      Flagged users{flaggedCount > 0 ? ` (${flaggedCount})` : ''}
    </LinkButton>
  );
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
        actions={
          <>
            {review}
            {add}
          </>
        }
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
            rows={limit}
            statuses={statuses}
            roles={roles}
            departmentId={departmentId ?? ''}
            sort={sort}
            departments={departments}
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
                    <LinkButton href={href(1)} variant="secondary">
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
                    ? `Nothing matches ${activeFilters.join(' · ')}.`
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
                    // D54-2: no display name reads "Unnamed user", never the address, which keeps its own
                    // line. Action labels must still tell rows apart, so the address follows the name, or
                    // the row number when an unnamed user has no address either.
                    const displayName = user.displayName?.trim() || null;
                    const name = displayName ?? 'Unnamed user';
                    const label = user.email
                      ? `${name} · ${user.email}`
                      : (displayName ?? `${name} ${index + 1}`);
                    const picture = user.avatarDocumentId ?? null;
                    return (
                      <tr key={user.id}>
                        <Th scope="row" className={admin.rowHead}>
                          <div className={styles.person}>
                            <Avatar
                              name={displayName ?? ''}
                              seedId={user.id}
                              imageDocumentId={picture}
                              shape="circle"
                            />
                            <span className={styles.personText}>
                              <span className={styles.name}>{name}</span>
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
                          {user.lockReason ? (
                            <>
                              <Badge tone="error" className={styles.status ?? ''}>
                                Locked
                              </Badge>
                              {user.lockedUntil && (
                                <span className={styles.muted}>
                                  {' '}
                                  until{' '}
                                  <time dateTime={user.lockedUntil}>
                                    {formatInstant(user.lockedUntil)}
                                  </time>
                                </span>
                              )}
                            </>
                          ) : (
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
                              {STATUS_LABELS[user.status]}
                            </Badge>
                          )}
                        </Td>
                        <Td align="end">
                          <div className={styles.rowActions}>
                            <PictureEditor
                              userId={user.id}
                              name={name}
                              label={label}
                              imageDocumentId={picture}
                            />
                            <RolesEditor userId={user.id} label={label} roles={user.roles} />
                            {canCheckAccess && (
                              <LinkButton
                                href={`/settings/access/check?person=${encodeURIComponent(user.id)}`}
                                variant="ghost"
                                size="small"
                                aria-label={`Check access for ${label}`}
                              >
                                Check access
                              </LinkButton>
                            )}
                            {summary.ok &&
                              summary.data.canSendPasswordReset &&
                              user.email &&
                              user.status === 'active' && (
                                <PasswordReset userId={user.id} label={label} email={user.email} />
                              )}
                            {canChangeStatus &&
                              user.id !== me?.id &&
                              statusActions(user).map((action) => (
                                <StatusAction
                                  key={action}
                                  userId={user.id}
                                  name={name}
                                  label={label}
                                  action={action}
                                />
                              ))}
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
                      : `Showing ${count((page - 1) * limit + 1)}–${count((page - 1) * limit + items.length)}${total !== null ? ` of ${count(total)}` : ''}`}
                  </span>
                }
                pages={pageLinks}
                currentPage={page}
                {...(pastFirstPage ? { previousHref: href(page - 1) } : {})}
                {...(next ? { nextHref: href(next) } : {})}
              />
              <PageSize sizes={USER_PAGE_SIZES} size={limit} defaultSize={DEFAULT_SIZE} />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
