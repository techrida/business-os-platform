import { permissionChecker } from '@/components/p2/customers/permissions';
import { Avatar } from '@/components/ui/avatar';
import { canSeeAdmin } from '@/lib/kernel-format';
import { visibleGroups } from '@/lib/nav';

import { Brand } from './brand';
import { ShellNav, ShellNavSearch } from './shell-nav';
import { CollapseToggle, DrawerCloseButton } from './shell-state';
import styles from './sidebar.module.css';

export interface SidebarUser {
  name: string;
  detail: string;
}

/**
 * Expanded navigation on desktop, a rail on tablet and a drawer on mobile. Admin screens show
 * only for people who can see admin; permission-gated CRM items only for roles that grant them.
 */
export function Sidebar({ user, roles }: { user: SidebarUser; roles: readonly string[] }) {
  return (
    <div id="app-sidebar" className={styles.sidebar}>
      <div className={styles.top}>
        <Brand />
        <CollapseToggle />
        <DrawerCloseButton />
      </div>
      <ShellNavSearch className={styles.drawerSearch} />
      <ShellNav groups={visibleGroups(canSeeAdmin(roles), permissionChecker(roles))} />
      <div className={styles.footer}>
        <div className={styles.userCard}>
          <Avatar name={user.name.split(',')[0] ?? user.name} />
          <span className={styles.userText}>
            <span className={styles.userName}>{user.name}</span>
            <span className={styles.userDetail}>{user.detail}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
