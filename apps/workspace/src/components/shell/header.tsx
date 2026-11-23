import { NotificationsBell } from '@/app/(app)/notifications-bell';
import { Button } from '@/components/ui/button';

import { accountLabel } from './account-label';
import styles from './header.module.css';
import { ShellNavSearch } from './shell-nav';
import { MenuButton } from './shell-state';
import { Tooltip } from '@/components/ui/tooltip';

/** Workspace banner with navigation search and the current account. */
export function Header({ roles }: { roles: readonly string[] }) {
  const rolesText = accountLabel(roles);
  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <MenuButton />
        <Tooltip content={rolesText}>
          <p className={styles.roles}>{rolesText}</p>
        </Tooltip>
      </div>
      <div className={styles.tools}>
        <ShellNavSearch className={styles.search} />
        <NotificationsBell />
        <div className={styles.who}>
          {/* POST, not a link: signing out changes state, so a crawler or prefetch must not trigger it. */}
          <form noValidate method="post" action="/auth/logout">
            <Button type="submit" variant="secondary" size="small">
              Sign out
            </Button>
          </form>
        </div>
      </div>
    </header>
  );
}
