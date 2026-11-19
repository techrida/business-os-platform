import { RoleKeySchema } from '@bos/contracts';
import { notFound } from 'next/navigation';

import { requireAccess } from '../_lib/guard';
import { loadCatalogue } from '../_lib/load';
import { LoadError } from '../_lib/load-error';
import { isRoleEdited, orderRoles, roleGroups, rolePageHref } from '../_lib/role-model';
import { RoleList } from '../role-list';
import styles from '../roles.module.css';
import { RoleEditor } from './role-editor';

/**
 * One role's page under Access > By role (spec 6.1). Reads the live catalogue, so every value is
 * the saved grant, never the built-in default (D29). An unknown role is a 404.
 */
export default async function AccessRolePage({ params }: { params: Promise<{ role: string }> }) {
  const { role: raw } = await params;
  const parsed = RoleKeySchema.safeParse(raw);
  const path = parsed.success ? rolePageHref(parsed.data) : '/settings/access/roles';
  const { session, canWrite } = await requireAccess(path);
  if (!parsed.success) notFound();

  const catalogue = await loadCatalogue(session);
  if (!catalogue.ok) return <LoadError message={catalogue.message} retryHref={path} />;

  const role = catalogue.data.roles.find((r) => r.key === parsed.data);
  if (role === undefined) notFound();

  const { main, portal } = orderRoles(catalogue.data.roles);
  return (
    <div className={styles.frame}>
      <RoleList catalogue={catalogue.data} active={role.key} />
      <RoleEditor
        // A new revision (a save here or elsewhere) starts the editor fresh from the saved values.
        key={`${role.key}:${catalogue.data.revision}`}
        role={role}
        roles={[...main, ...portal].map((r) => ({ key: r.key, label: r.label }))}
        groups={roleGroups(catalogue.data, role)}
        edited={isRoleEdited(catalogue.data, role.key)}
        canWrite={canWrite}
        revision={catalogue.data.revision}
      />
    </div>
  );
}
