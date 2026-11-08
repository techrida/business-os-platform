import type { Metadata } from 'next';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';
import { LinkButton } from '@/components/ui/button';
import { EmptyState } from '@/components/ui/empty-state';
import { Icon } from '@/components/ui/icon';
import { Page, PageHeader } from '@/components/ui/page';
import { Table, Td, Th } from '@/components/ui/table';
import { listUsers } from '@/lib/api-admin';

import admin from '../admin.module.css';
import { requireSession } from '../guard';
import { section } from '../section';
import { SectionError } from '../ui';
import { roleLabel } from './role-checkboxes';
import { RolesEditor } from './roles-editor';
import styles from './users.module.css';

export const metadata: Metadata = { title: 'Users · Business OS' };

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Active reads as success, invited as waiting, anything else as plain. */
function statusTone(status: string): 'success' | 'warning' | 'neutral' {
  if (status === 'active') return 'success';
  if (status === 'invited') return 'warning';
  return 'neutral';
}

/** Up to two letters from the name, else the first letter of the email, else a person glyph. */
function Avatar({ name, email }: { name: string | null; email: string | null }) {
  const words = (name ?? '').trim().split(/\s+/).filter(Boolean);
  const letters =
    words.length > 1
      ? `${words[0]?.charAt(0) ?? ''}${words[words.length - 1]?.charAt(0) ?? ''}`
      : (words[0] ?? email?.trim() ?? '').slice(0, words.length === 1 ? 2 : 1);
  return (
    <span aria-hidden="true" className={styles.avatar}>
      {letters === '' ? <Icon name="user" size={16} /> : letters}
    </span>
  );
}

export default async function UsersPage({
  searchParams,
}: {
  // Next 16: searchParams is a Promise.
  searchParams: Promise<{ after?: string | string[] }>;
}) {
  const { after: rawAfter } = await searchParams;
  const after = typeof rawAfter === 'string' && UUID.test(rawAfter) ? rawAfter : undefined;
  const session = await requireSession(after ? `/admin/users?after=${after}` : '/admin/users');

  const users = await section('view users', () =>
    listUsers(session, after ? { limit: PAGE_SIZE, after } : { limit: PAGE_SIZE }),
  );

  const invite = <LinkButton href="/admin/users/new">Invite user</LinkButton>;

  return (
    <Page>
      <PageHeader
        title="Users"
        description="Invite colleagues and set the roles they hold."
        actions={invite}
      />

      {!users.ok ? (
        <SectionError message={users.message} />
      ) : users.data.items.length === 0 ? (
        <EmptyState
          icon="users"
          title={after ? 'No more users' : 'No users yet'}
          action={
            after ? (
              <LinkButton href="/admin/users" variant="secondary">
                Back to the first page
              </LinkButton>
            ) : (
              invite
            )
          }
        >
          {after
            ? 'You have reached the end of the list.'
            : 'Invite the first person to give them access.'}
        </EmptyState>
      ) : (
        <>
          <Table caption="Users and their roles" className={admin.local ?? ''}>
            <thead>
              <tr>
                <Th>Person</Th>
                <Th>Status</Th>
                <Th>Roles</Th>
                <Th align="end">Action</Th>
              </tr>
            </thead>
            <tbody>
              {users.data.items.map((user) => {
                const label = user.displayName ?? user.email ?? 'this user';
                return (
                  <tr key={user.id}>
                    <Th scope="row" className={admin.rowHead ?? ''}>
                      <div className={styles.person}>
                        <Avatar name={user.displayName} email={user.email} />
                        <span className={styles.personText}>
                          <span className={styles.name}>
                            {user.displayName ?? <span className={styles.muted}>No name yet</span>}
                          </span>
                          {user.email ? <span className={styles.email}>{user.email}</span> : null}
                        </span>
                      </div>
                    </Th>
                    <Td>
                      <Badge tone={statusTone(user.status)} className={styles.status ?? ''}>
                        {user.status}
                      </Badge>
                    </Td>
                    <Td>
                      {user.roles.length === 0 ? (
                        <span className={styles.muted}>No roles</span>
                      ) : (
                        <ul className={styles.roles}>
                          {user.roles.map((role) => (
                            <li key={role}>
                              <Badge>{roleLabel(role)}</Badge>
                            </li>
                          ))}
                        </ul>
                      )}
                    </Td>
                    <Td align="end">
                      <RolesEditor userId={user.id} label={label} roles={user.roles} />
                    </Td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
          <div className={styles.pagerRow}>
            <p className={styles.count}>
              Showing {users.data.items.length} {users.data.items.length === 1 ? 'user' : 'users'}
            </p>
            <nav className={styles.pager} aria-label="Users pages">
              {after ? (
                <Link className={styles.pagerLink} href="/admin/users">
                  Back to the first page
                </Link>
              ) : null}
              {users.data.nextAfter ? (
                <Link
                  className={styles.pagerLink}
                  href={`/admin/users?after=${users.data.nextAfter}`}
                >
                  Next {PAGE_SIZE} users
                </Link>
              ) : null}
            </nav>
          </div>
        </>
      )}
    </Page>
  );
}
