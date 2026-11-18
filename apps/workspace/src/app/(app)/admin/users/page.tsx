import { ROLE_KEYS, RoleKeySchema } from '@bos/contracts';
import type { Metadata } from 'next';
import Link from 'next/link';

import { Avatar } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Button, LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Select } from '@/components/ui/field';
import { Page, PageHeader } from '@/components/ui/page';
import { Pagination } from '@/components/ui/pagination';
import { SearchInput } from '@/components/ui/search-input';
import { StatCard } from '@/components/ui/stat-card';
import { Table, Td, Th } from '@/components/ui/table';
import { listUsers } from '@/lib/api-admin';

import admin from '../admin.module.css';
import { requireSession } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { PageSize } from './page-size';
import { roleLabel } from './role-checkboxes';
import { RolesEditor } from './roles-editor';
import styles from './users.module.css';

export const metadata: Metadata = { title: 'Users · Business OS' };

const DEFAULT_SIZE = 50;
const USER_PAGE_SIZES = [5, 10, 25, DEFAULT_SIZE];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Params = Record<string, string | string[] | undefined>;

export default async function UsersPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const limit = USER_PAGE_SIZES.find((n) => String(n) === params.limit) ?? DEFAULT_SIZE;
  const after = typeof params.after === 'string' && UUID.test(params.after) ? params.after : '';
  const q = typeof params.q === 'string' ? params.q.trim() : '';
  const role = RoleKeySchema.safeParse(params.role);
  const status =
    typeof params.status === 'string' && ['active', 'invited', 'inactive'].includes(params.status)
      ? params.status
      : '';
  function href(cursor: string, withFilters = true) {
    const query = new URLSearchParams();
    if (cursor) query.set('after', cursor);
    if (limit !== DEFAULT_SIZE) query.set('limit', String(limit));
    if (withFilters && q) query.set('q', q);
    if (withFilters && role.success) query.set('role', role.data);
    if (withFilters && status) query.set('status', status);
    return query.size ? `/admin/users?${query}` : '/admin/users';
  }

  const session = await requireSession(href(after));
  // Fetch one extra row so a full final page never advertises an empty next page.
  const users = await section('view users', () =>
    listUsers(session, { limit: limit + 1, ...(after ? { after } : {}) }),
  );
  const items = users.ok ? users.data.items.slice(0, limit) : [];
  const next = users.ok && users.data.items.length > limit ? items.at(-1)?.id : undefined;
  const paged = Boolean(after || next);
  const filtered = Boolean(q || role.success || status);
  const needle = q.toLowerCase();
  const visible = items.filter(
    (user) =>
      (!role.success || user.roles.includes(role.data)) &&
      (!status || user.status === status) &&
      (!q || [user.displayName, user.email].some((text) => text?.toLowerCase().includes(needle))),
  );
  const add = (
    <LinkButton href="/admin/users/new" size="large">
      <span aria-hidden="true">＋</span>Add user
    </LinkButton>
  );

  return (
    <Page className={admin.page}>
      <PageHeader
        title="Users"
        description="Invite colleagues and manage their access."
        actions={add}
      />
      {!users.ok ? (
        <SectionError message={users.message} />
      ) : (
        <>
          {!paged && (
            <div className={styles.stats}>
              <StatCard label="Total users" value={items.length} icon="users" />
              <StatCard
                label="Active users"
                value={items.filter((u) => u.status === 'active').length}
                icon="check-circle"
                tone="success"
              />
              <StatCard
                label="Invited users"
                value={items.filter((u) => u.status === 'invited').length}
                icon="inbox"
                tone="warning"
              />
              <StatCard
                label="Inactive users"
                value={items.filter((u) => u.status === 'inactive').length}
                icon="user"
                tone="neutral"
              />
            </div>
          )}
          {items.length > 0 && (
            <form className={styles.filters} role="search" action="/admin/users">
              {limit !== DEFAULT_SIZE && <input type="hidden" name="limit" value={limit} />}
              {after && <input type="hidden" name="after" value={after} />}
              <SearchInput
                name="q"
                defaultValue={q}
                aria-label={paged ? 'Search users on this page' : 'Search users'}
                placeholder={paged ? 'Search users on this page' : 'Search users'}
                wrapperClassName={styles.search}
              />
              <div className={styles.filterActions}>
                <Select name="status" aria-label="Filter by status" defaultValue={status}>
                  <option value="">All statuses</option>
                  <option value="active">Active</option>
                  <option value="invited">Invited</option>
                  <option value="inactive">Inactive</option>
                </Select>
                <Select
                  name="role"
                  aria-label="Filter by role"
                  defaultValue={role.success ? role.data : ''}
                >
                  <option value="">All roles</option>
                  {ROLE_KEYS.map((key) => (
                    <option key={key} value={key}>
                      {roleLabel(key)}
                    </option>
                  ))}
                </Select>
                <Button variant="secondary" size="small" type="submit">
                  Apply
                </Button>
                {filtered && <Link href={href(after, false)}>Clear</Link>}
              </div>
            </form>
          )}
          <div className={styles.results}>
            {visible.length === 0 ? (
              <EmptyState
                icon="users"
                title={
                  items.length ? 'No matching users' : after ? 'No more users' : 'No users yet'
                }
                action={
                  items.length ? (
                    <LinkButton href={href(after, false)} variant="secondary">
                      Clear filters
                    </LinkButton>
                  ) : after ? (
                    <LinkButton href={href('')} variant="secondary">
                      Back to the first page
                    </LinkButton>
                  ) : (
                    add
                  )
                }
              >
                {items.length
                  ? 'Try another name, email or filter.'
                  : after
                    ? 'You have reached the end of the list.'
                    : 'Invite the first person to give them access.'}
              </EmptyState>
            ) : (
              <Table
                caption="Users and their roles"
                minWidth={610}
                className={`${admin.local} ${styles.directory}`}
              >
                <thead>
                  <tr>
                    <Th>User</Th>
                    <Th>Roles</Th>
                    <Th>Status</Th>
                    <Th align="end">Action</Th>
                  </tr>
                </thead>
                <tbody>
                  {visible.map((user, index) => {
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
                          <RolesEditor userId={user.id} label={label} roles={user.roles} />
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
                  <>
                    Showing {visible.length} of {items.length}{' '}
                    {items.length === 1 ? 'user' : 'users'}
                    {paged ? ' on this page' : ''}
                    {after && (
                      <>
                        {' '}
                        · <Link href={href('')}>Back to the first page</Link>
                      </>
                    )}
                  </>
                }
                {...(next ? { nextHref: href(next) } : {})}
              />
              <PageSize
                sizes={USER_PAGE_SIZES}
                size={limit}
                q={q}
                role={role.success ? role.data : ''}
                status={status}
              />
            </div>
          </div>
        </>
      )}
    </Page>
  );
}
