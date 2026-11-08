import {
  DEFAULT_ROLE_PERMISSIONS,
  PERMISSIONS,
  ROLE_KEYS,
  SCOPES,
  SOD_PERMISSIONS,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';

import { listUsers } from '@/lib/api-admin';

import styles from '../admin.module.css';
import { requireSession } from '../guard';
import { section } from '../section';
import { Notice, PageHead } from '../ui';

const SCOPE_TEXT: Record<Scope, string> = {
  own: 'Records the person created or owns.',
  department: "Records of the person's department.",
  customer_org: "Records of the person's customer organisation.",
  all: 'Every record in the organisation.',
};

/** Group rows by the part before the first dot (admin, approvals, documents ...). */
function groupPermissions(): [string, Permission[]][] {
  const groups = new Map<string, Permission[]>();
  for (const permission of PERMISSIONS) {
    const area = permission.split('.')[0] ?? permission;
    groups.set(area, [...(groups.get(area) ?? []), permission]);
  }
  return [...groups];
}

const COUNT_LIMIT = 200;

export default async function RolesPage() {
  const session = await requireSession('/admin/roles');

  // The live part: how many users hold each role. It needs `admin.users.read`; without it the
  // matrix still shows, just without counts.
  const users = await section('view users', () => listUsers(session, { limit: COUNT_LIMIT }));
  const counts = new Map<RoleKey, number>();
  if (users.ok) {
    for (const user of users.data.items) {
      for (const role of user.roles) counts.set(role, (counts.get(role) ?? 0) + 1);
    }
  }
  const countsPartial = users.ok && users.data.nextAfter !== null;

  return (
    <>
      <PageHead title="Roles and permissions">
        What each role may do, and how far each permission reaches.
      </PageHead>

      <Notice>
        This matrix is read-only. Changes need the P2 roles editor: the API has no route to read or
        write role permissions yet, so the table shows the built-in defaults from the shared
        contract.
      </Notice>
      {!users.ok ? (
        <Notice>User counts are not shown. {users.message}</Notice>
      ) : countsPartial ? (
        <Notice>User counts cover the first {COUNT_LIMIT} users only.</Notice>
      ) : null}

      <div className={styles.tableWrap} role="region" aria-labelledby="matrix-caption" tabIndex={0}>
        <table className={`${styles.table} ${styles.matrix}`}>
          <caption id="matrix-caption">Permission scope by role (defaults)</caption>
          <thead>
            <tr>
              <th scope="col">Permission</th>
              {ROLE_KEYS.map((role) => (
                <th key={role} scope="col">
                  {role}
                  {users.ok ? (
                    <span className={styles.roleCount}>
                      {counts.get(role) ?? 0} {counts.get(role) === 1 ? 'user' : 'users'}
                    </span>
                  ) : null}
                </th>
              ))}
            </tr>
          </thead>
          {groupPermissions().map(([area, permissions]) => (
            <tbody key={area}>
              <tr className={styles.groupRow}>
                <th scope="rowgroup" colSpan={ROLE_KEYS.length + 1}>
                  {area}
                </th>
              </tr>
              {permissions.map((permission) => (
                <tr key={permission}>
                  <th scope="row">
                    <span className={styles.mono}>{permission}</span>
                    {SOD_PERMISSIONS.includes(permission) ? (
                      <span className={`${styles.hint} ${styles.cellWrap}`}>
                        Separation of duties applies: not the person who prepared it.
                      </span>
                    ) : null}
                  </th>
                  {ROLE_KEYS.map((role) => {
                    const scope = DEFAULT_ROLE_PERMISSIONS[role][permission];
                    return (
                      <td key={role}>
                        {scope ? (
                          <span className={styles.scope}>{scope}</span>
                        ) : (
                          <>
                            <span aria-hidden="true" className={styles.scopeNone}>
                              -
                            </span>
                            <span className={styles.srOnly}>No access</span>
                          </>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          ))}
        </table>
      </div>

      <section className={styles.section} aria-labelledby="scope-heading">
        <div className={styles.sectionHead}>
          <h2 id="scope-heading">What the scopes mean</h2>
        </div>
        <dl className={styles.stack}>
          {SCOPES.map((scope) => (
            <div key={scope}>
              <dt>
                <span className={styles.scope}>{scope}</span>
              </dt>
              <dd className={styles.muted} style={{ margin: '0.25rem 0 0' }}>
                {SCOPE_TEXT[scope]}
              </dd>
            </div>
          ))}
        </dl>
      </section>
    </>
  );
}
