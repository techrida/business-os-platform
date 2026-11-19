import { EmptyState } from '@/components/ui/empty-state';

import { requireAccess } from './_lib/guard';
import { loadCatalogue } from './_lib/load';
import { LoadError } from './_lib/load-error';
import { RoleList } from './role-list';
import styles from './roles.module.css';

const PATH = '/settings/access/roles';

/**
 * Access > By role (spec 6.1): every role, one at a time. The Access layout draws the page title and
 * the tabs; this page draws the role list and, on a wide screen, a note to pick one.
 */
export default async function AccessRolesPage() {
  const { session } = await requireAccess(PATH);
  const catalogue = await loadCatalogue(session);
  if (!catalogue.ok) return <LoadError message={catalogue.message} retryHref={PATH} />;

  return (
    <div className={styles.frame}>
      <RoleList catalogue={catalogue.data} />
      <div className={styles.pick}>
        <EmptyState title="Pick a role" icon="shield-check">
          Choose a role to see everything it can do and change it.
        </EmptyState>
      </div>
    </div>
  );
}
