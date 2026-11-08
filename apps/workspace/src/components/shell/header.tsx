import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import { HeaderTitle } from './header-title';
import styles from './header.module.css';
import { MenuButton } from './shell-state';

/**
 * The top bar (the page's `banner`): menu button on phones and the page title on the left;
 * search (disabled in P0), the organisation kind, the roles and Sign out on the right. A bell
 * for notifications is left out until P1 has notifications.
 *
 * It must stay a direct child of the layout, outside <main>: a <header> nested in <main> or a
 * section loses the banner role.
 */
export function Header({ orgKind, roles }: { orgKind: string; roles: readonly string[] }) {
  const rolesText = roles.length > 0 ? roles.join(', ') : 'No roles';
  return (
    <header className={styles.header}>
      <div className={styles.lead}>
        <MenuButton />
        <HeaderTitle />
      </div>
      <div className={styles.tools}>
        <div className={styles.search}>
          <Icon name="search" size={16} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            aria-label="Search"
            placeholder="Search (coming soon)"
            disabled
          />
        </div>
        <div className={styles.who}>
          <Badge tone="info" className={styles.kind}>
            {orgKind}
          </Badge>
          <span className={styles.roles} title={rolesText}>
            {rolesText}
          </span>
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
