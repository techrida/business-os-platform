import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

import { accountLabel } from './account-label';
import styles from './header.module.css';
import { ShellNavSearch } from './shell-nav';
import { MenuButton } from './shell-state';

/** Workspace banner with navigation search and the current account. */
export function Header({ orgKind, roles }: { orgKind: string; roles: readonly string[] }) {
  const rolesText = accountLabel(roles);
  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <MenuButton />
        <p className={styles.roles} title={rolesText}>
          {rolesText}
        </p>
      </div>
      <div className={styles.tools}>
        <ShellNavSearch className={styles.search} />
        <div className={styles.who}>
          <Badge tone="info" className={styles.kind}>
            {orgKind}
          </Badge>
          {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
          <form method="post" action="/auth/logout">
            <Button type="submit" variant="secondary" size="small">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
