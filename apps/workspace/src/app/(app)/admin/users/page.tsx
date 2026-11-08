import Link from 'next/link';

import { listUsers } from '@/lib/api-admin';

import styles from '../admin.module.css';
import { requireSession } from '../guard';
import { section } from '../section';
import { PageHead, SectionError } from '../ui';
import { InviteForm } from './invite-form';
import { RolesEditor } from './roles-editor';

const PAGE_SIZE = 50;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const STATUS_CLASS: Record<string, string> = {
  active: styles.chipOk ?? '',
  invited: styles.chipWarn ?? '',
};

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

  return (
    <>
      <PageHead title="Users">Invite colleagues and set the roles they hold.</PageHead>

      <section className={styles.section} aria-labelledby="invite-heading" style={{ marginTop: 0 }}>
        <div className={styles.sectionHead}>
          <h2 id="invite-heading">Invite a user</h2>
        </div>
        <InviteForm />
      </section>

      <section className={styles.section} aria-labelledby="list-heading">
        <div className={styles.sectionHead}>
          <h2 id="list-heading">People</h2>
        </div>
        {!users.ok ? (
          <SectionError message={users.message} />
        ) : users.data.items.length === 0 ? (
          <p className={styles.empty}>
            {after ? 'No more users.' : 'No users yet. Invite the first person above.'}
          </p>
        ) : (
          <>
            <div
              className={styles.tableWrap}
              role="region"
              aria-labelledby="users-caption"
              tabIndex={0}
            >
              <table className={styles.table}>
                <caption id="users-caption" className={styles.srOnly}>
                  Users and their roles
                </caption>
                <thead>
                  <tr>
                    <th scope="col">Person</th>
                    <th scope="col">Status</th>
                    <th scope="col">Roles</th>
                    <th scope="col">Change roles</th>
                  </tr>
                </thead>
                <tbody>
                  {users.data.items.map((user) => {
                    const label = user.displayName ?? user.email ?? 'this user';
                    return (
                      <tr key={user.id}>
                        <th scope="row">
                          <span className={styles.cellWrap}>
                            {user.displayName ?? <span className={styles.muted}>No name yet</span>}
                          </span>
                          {user.email ? (
                            <span className={`${styles.hint} ${styles.cellWrap}`}>
                              {user.email}
                            </span>
                          ) : null}
                        </th>
                        <td>
                          <span
                            className={`${styles.chip} ${STATUS_CLASS[user.status] ?? styles.chipNeutral}`}
                          >
                            {user.status}
                          </span>
                        </td>
                        <td>
                          {user.roles.length === 0 ? (
                            <span className={styles.muted}>No roles</span>
                          ) : (
                            <ul className={styles.chips}>
                              {user.roles.map((role) => (
                                <li key={role} className={styles.chip}>
                                  {role}
                                </li>
                              ))}
                            </ul>
                          )}
                        </td>
                        <td>
                          <RolesEditor userId={user.id} label={label} roles={user.roles} />
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className={styles.pager} aria-label="Users pages">
              {after ? (
                <Link className={styles.link} href="/admin/users">
                  Back to the first page
                </Link>
              ) : null}
              {users.data.nextAfter ? (
                <Link className={styles.link} href={`/admin/users?after=${users.data.nextAfter}`}>
                  Next {PAGE_SIZE} users
                </Link>
              ) : null}
            </nav>
          </>
        )}
      </section>
    </>
  );
}
