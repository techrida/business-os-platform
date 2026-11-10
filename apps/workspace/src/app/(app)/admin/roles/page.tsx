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

import { Alert } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Page, PageHeader } from '@/components/ui/page';
import { FactList, Panel } from '@/components/ui/panel';
import { Table, Td, Th } from '@/components/ui/table';
import { listUsers } from '@/lib/api-admin';

import admin from '../admin.module.css';
import { requireSession } from '../guard';
import { section } from '../section';
import styles from './roles.module.css';

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
// The permission column plus one column per role; under this width the table scrolls sideways.
const MATRIX_MIN_WIDTH = 260 + 132 * ROLE_KEYS.length;

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
    <Page>
      <PageHeader
        title="Roles and permissions"
        description="What each role may do, and how far each permission reaches."
      />

      <div className={styles.notices}>
        <Alert tone="info">
          This matrix is read-only. Role editing is unavailable: the API has no route to read or
          write role permissions yet, so the table shows the built-in defaults from the shared
          contract.
        </Alert>
        {!users.ok ? (
          <Alert tone="info">User counts are not shown. {users.message}</Alert>
        ) : countsPartial ? (
          <Alert tone="info">User counts cover the first {COUNT_LIMIT} users only.</Alert>
        ) : null}
      </div>

      <Table
        caption="Permission scope by role (defaults)"
        stickyFirstColumn
        minWidth={MATRIX_MIN_WIDTH}
        className={`${admin.local} ${styles.matrix}`}
      >
        <thead>
          <tr>
            <Th>Permission</Th>
            {ROLE_KEYS.map((role) => (
              <Th key={role} className={styles.roleHead}>
                <span className={styles.roleName}>{role}</span>
                {users.ok ? (
                  <span className={styles.count}>
                    {counts.get(role) ?? 0} {counts.get(role) === 1 ? 'user' : 'users'}
                  </span>
                ) : null}
              </Th>
            ))}
          </tr>
        </thead>
        {groupPermissions().map(([area, permissions]) => (
          <tbody key={area}>
            <tr>
              <Th scope="rowgroup" colSpan={ROLE_KEYS.length + 1} className={admin.group}>
                {area}
              </Th>
            </tr>
            {permissions.map((permission) => (
              <tr key={permission}>
                <Th scope="row" className={admin.rowHead}>
                  <span className={styles.perm}>{permission}</span>
                  {SOD_PERMISSIONS.includes(permission) ? (
                    <span className={styles.sod}>
                      Separation of duties applies: not the person who prepared it.
                    </span>
                  ) : null}
                </Th>
                {ROLE_KEYS.map((role) => {
                  const scope = DEFAULT_ROLE_PERMISSIONS[role][permission];
                  return (
                    <Td key={role} className={styles.cell}>
                      {scope ? (
                        <Badge tone="info">{scope}</Badge>
                      ) : (
                        <>
                          <span aria-hidden="true" className={styles.none}>
                            &mdash;
                          </span>
                          <span className="sr-only">No access</span>
                        </>
                      )}
                    </Td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        ))}
      </Table>

      <Panel title="What the scopes mean">
        <FactList
          facts={SCOPES.map((scope) => ({
            key: scope,
            label: <Badge tone="info">{scope}</Badge>,
            value: SCOPE_TEXT[scope],
          }))}
        />
      </Panel>
    </Page>
  );
}
