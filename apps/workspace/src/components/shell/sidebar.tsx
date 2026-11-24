import { Avatar } from '@/components/ui/avatar';
import { visibleGroups } from '@/lib/nav';
import { visibleSettingsGroups } from '@/lib/settings-nav';

import { Brand, type BrandProps } from './brand';
import { ProfilePictureDialog } from './profile-picture-dialog';
import { ShellNav, ShellNavSearch } from './shell-nav';
import { CollapseToggle, DrawerCloseButton } from './shell-state';
import styles from './sidebar.module.css';

export interface SidebarUser {
  name: string;
  detail: string;
  /**
   * The person's `app.users.id` (a guid): the initials colour and the owner of their picture. Without it the
   * avatar shows only and cannot be changed from here.
   */
  id?: string | null | undefined;
  /** Their current picture; null or absent shows initials. */
  imageDocumentId?: string | null | undefined;
}

/**
 * Expanded navigation on desktop, a rail on tablet and a drawer on mobile. `permissions` are the person's
 * effective grants (`getPermissions`): a gated item shows only when they hold its permission, and Settings
 * only when at least one settings section opens for them.
 */
export function Sidebar({
  user,
  permissions,
  counts = {},
  brand = {},
}: {
  user: SidebarUser;
  permissions: readonly string[];
  counts?: Readonly<Record<string, number>>;
  /** The company's name and logo address (R6Q20); absent or empty shows the product name. */
  brand?: Pick<BrandProps, 'name' | 'logoSrc'>;
}) {
  const held = new Set(permissions);
  const can = (permission: string) => held.has(permission);
  const avatarName = user.name.split(',')[0] ?? user.name;
  const imageDocumentId = user.imageDocumentId ?? null;
  return (
    <div id="app-sidebar" className={styles.sidebar}>
      <div className={styles.top}>
        <Brand name={brand.name} logoSrc={brand.logoSrc} />
        <CollapseToggle />
        <DrawerCloseButton />
      </div>
      <ShellNavSearch className={styles.drawerSearch} />
      <ShellNav
        groups={visibleGroups(visibleSettingsGroups(can).length > 0, can)}
        counts={counts}
      />
      <div className={styles.footer}>
        <div className={styles.userCard}>
          {user.id ? (
            <ProfilePictureDialog
              userId={user.id}
              imageDocumentId={imageDocumentId}
              name={avatarName}
            />
          ) : (
            <Avatar name={avatarName} imageDocumentId={imageDocumentId} />
          )}
          <span className={styles.userText}>
            <span className={styles.userName}>{user.name}</span>
            <span className={styles.userDetail}>{user.detail}</span>
          </span>
        </div>
      </div>
    </div>
  );
}
