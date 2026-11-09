import { NotificationsBell } from '@/app/(app)/notifications-bell';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Icon } from '@/components/ui/icon';

import styles from './header.module.css';
import { MenuButton } from './shell-state';

/**
 * The top bar (the page's `banner`). Left: the menu button on phones and the signed-in roles,
 * which is what the Figma bar shows ("Super Admin"). Right: search (disabled until search
 * exists), the notifications bell, the organisation kind and Sign out.
 *
 * Left out on purpose: the Figma cloud, undo and redo icons, which would look like working
 * controls on a page with nothing to save or undo. Page titles belong to each page's own h1, as
 * in Figma.
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
        <p className={styles.roles} title={rolesText}>
          {rolesText}
        </p>
      </div>
      <div className={styles.tools}>
        <div className={styles.search}>
          <Icon name="search" size={18} className={styles.searchIcon} />
          <input
            type="search"
            className={styles.searchInput}
            aria-label="Search"
            placeholder="Search"
            disabled
          />
        </div>
        <NotificationsBell />
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
