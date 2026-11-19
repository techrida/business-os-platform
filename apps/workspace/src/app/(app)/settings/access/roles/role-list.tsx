import type { AccessCatalogueResponse, AccessRoleInfo, RoleKey } from '@bos/contracts';
import Link from 'next/link';

import { Badge } from '@/components/ui/badge';

import { peopleText } from './_lib/reach';
import { isRoleEdited, orderRoles, rolePageHref } from './_lib/role-model';
import styles from './roles.module.css';

function RoleLinks({
  roles,
  catalogue,
  active,
}: {
  roles: readonly AccessRoleInfo[];
  catalogue: AccessCatalogueResponse;
  active: RoleKey | undefined;
}) {
  return (
    <ul className={styles.roles}>
      {roles.map((role) => (
        <li key={role.key}>
          <Link
            href={rolePageHref(role.key)}
            className={styles.roleLink}
            aria-current={role.key === active ? 'page' : undefined}
          >
            <span className={styles.roleName}>{role.label}</span>
            <span className={styles.roleCount}>{peopleText(role.peopleCount)}</span>
            {isRoleEdited(catalogue, role.key) ? (
              <Badge tone="info" className={styles.roleEdited}>
                Edited
              </Badge>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}

/**
 * Every role the API returns (spec 6.1): Founder first, staff roles by name, then the portal roles
 * under their own heading. Each entry shows its people count and "Edited" when any of its values
 * differs from the default. On a role page it is hidden under 1024px, where the "Role" select
 * takes its place.
 */
export function RoleList({
  catalogue,
  active,
}: {
  catalogue: AccessCatalogueResponse;
  active?: RoleKey;
}) {
  const { main, portal } = orderRoles(catalogue.roles);
  const cls = [styles.list, active ? styles.listOnRolePage : undefined].filter(Boolean).join(' ');
  return (
    <nav aria-label="Roles" className={cls}>
      <RoleLinks roles={main} catalogue={catalogue} active={active} />
      {portal.length > 0 ? (
        <>
          <h2 className={styles.listHeading}>Portal</h2>
          <RoleLinks roles={portal} catalogue={catalogue} active={active} />
        </>
      ) : null}
    </nav>
  );
}
