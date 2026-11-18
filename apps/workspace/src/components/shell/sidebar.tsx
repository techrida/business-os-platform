import { Avatar } from '@/components/ui/avatar';
import { NAV_GROUPS } from '@/lib/nav';

import { Brand } from './brand';
import { ShellNav, ShellNavSearch } from './shell-nav';
import { CollapseToggle, DrawerCloseButton } from './shell-state';
import styles from './sidebar.module.css';

export interface SidebarUser {
  name: string;
  detail: string;
}

/** Expanded navigation on desktop, a rail on tablet and a drawer on mobile. */
export function Sidebar({ user }: { user: SidebarUser }) {
  return (
    <div id="app-sidebar" className={styles.sidebar}>
      <div className={styles.top}>
        <Brand />
        <CollapseToggle />
        <DrawerCloseButton />
      </div>
      <ShellNavSearch className={styles.drawerSearch} />
      <ShellNav groups={NAV_GROUPS} />
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
