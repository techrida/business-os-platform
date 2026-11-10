/**
 * The sidebar as data. Groups and items follow the Figma sidebar (node 727:10457) and the P1
 * screen map. Pure data with no React import, so unit tests and the header title lookup can use
 * it anywhere.
 *
 * An item is "built" when it has an `href`: it renders as a link. Other items render as
 * plain disabled rows. `phase` and SHIPPED_PHASES are internal and never shown to users.
 * When an item ships, give it an `href` and a phase in SHIPPED_PHASES; nav.test.ts keeps
 * the two in step.
 *
 * Items with `audience: 'admin'` are shown only to people who can see the admin screens. The
 * server decides that (canSeeAdmin in kernel-format.ts) and passes the answer to the sidebar:
 * this file stays free of server code because the header title (a client component) imports it.
 *
 * "Estimates" is left out on purpose: decision D3 merged it into Quotations. "Approvals" and
 * "User" are not listed: they are Work > Inbox and Administration > Users.
 */

export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'later';

/** Icons the sidebar can show. The drawings live in components/ui/icon.tsx. */
export type NavIconName =
  | 'home'
  | 'layers'
  | 'users'
  | 'briefcase'
  | 'building'
  | 'target'
  | 'trending-up'
  | 'file-text'
  | 'list-checks'
  | 'kanban'
  | 'receipt'
  | 'repeat'
  | 'credit-card'
  | 'banknote'
  | 'settings'
  | 'help-circle'
  | 'inbox'
  | 'shield-check'
  | 'git-branch';

export interface NavItem {
  label: string;
  /** Present only on built items. */
  href?: string;
  icon: NavIconName;
  /** Internal: the phase that builds this item. Never shown to users. */
  phase: Phase;
  /**
   * Optional number shown in a pill at the row's end (the Figma "Organizations 4"). Only built
   * items show it, and only when it is above zero. P0 has nothing to count, so no item sets it.
   */
  count?: number;
  /** `admin`: shown only to people who can see the admin screens. */
  audience?: 'admin';
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

/** Internal: phases whose items may be built and linked. Never shown to users. */
export const SHIPPED_PHASES: readonly Phase[] = ['P0', 'P1'];

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Overview', href: '/', icon: 'home', phase: 'P0' }],
  },
  {
    label: 'Work',
    items: [
      { label: 'Inbox', href: '/inbox', icon: 'inbox', phase: 'P1' },
      { label: 'Memos', href: '/memos', icon: 'file-text', phase: 'P1' },
    ],
  },
  {
    label: 'Administration',
    items: [
      { label: 'Users', href: '/admin/users', icon: 'users', phase: 'P1', audience: 'admin' },
      {
        label: 'Roles & Permissions',
        href: '/admin/roles',
        icon: 'shield-check',
        phase: 'P1',
        audience: 'admin',
      },
      {
        label: 'Approval Workflows',
        href: '/admin/workflows',
        icon: 'git-branch',
        phase: 'P1',
        audience: 'admin',
      },
    ],
  },
  {
    label: 'Organization',
    items: [
      { label: 'Department', icon: 'layers', phase: 'P1' },
      { label: 'Projects', icon: 'briefcase', phase: 'later' },
    ],
  },
  {
    label: 'CRM',
    items: [
      { label: 'Organizations', icon: 'building', phase: 'P2' },
      { label: 'Contacts', icon: 'users', phase: 'P2' },
      { label: 'Leads', icon: 'target', phase: 'P2' },
      { label: 'Opportunities', icon: 'trending-up', phase: 'P2' },
      { label: 'Quotations', icon: 'file-text', phase: 'P2' },
      { label: 'Activities & Tasks', icon: 'list-checks', phase: 'P2' },
    ],
  },
  {
    label: 'Sales Management',
    items: [{ label: 'Sales Pipeline', icon: 'kanban', phase: 'P2' }],
  },
  {
    label: 'Sales',
    items: [
      { label: 'Invoices', icon: 'receipt', phase: 'P3' },
      // Not in the PRD yet (see the Figma notes), so parked at "later" until it is confirmed.
      { label: 'Recurring Invoices', icon: 'repeat', phase: 'later' },
    ],
  },
  {
    label: 'Payments',
    items: [
      { label: 'Payment Methods', icon: 'credit-card', phase: 'P3' },
      { label: 'Payment to Confirm', icon: 'banknote', phase: 'P3' },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Settings',
        href: '/admin/settings',
        icon: 'settings',
        phase: 'P1',
        audience: 'admin',
      },
      { label: 'Help', icon: 'help-circle', phase: 'later' },
    ],
  },
];

export const APP_NAME = 'Business OS';

/** True when the item is built and links somewhere. */
export function isBuilt(item: NavItem): item is NavItem & { href: string } {
  return item.href !== undefined;
}

/**
 * The groups a person sees: unbuilt items stay as disabled rows, admin-only items go
 * unless `showAdmin`, and a group left with no items goes too.
 */
export function visibleGroups(showAdmin: boolean): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter((item) => item.audience !== 'admin' || showAdmin),
  })).filter((group) => group.items.length > 0);
}

/** True when `pathname` is the item's page or one under it (`/inbox` owns `/inbox/abc`). */
export function ownsPath(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
}

/** Page title for a route: the label of the built item that owns the path, else the app name. */
export function titleForPath(pathname: string): string {
  let best: (NavItem & { href: string }) | undefined;
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (!isBuilt(item) || !ownsPath(item.href, pathname)) continue;
      if (best === undefined || item.href.length > best.href.length) best = item;
    }
  }
  return best?.label ?? APP_NAME;
}
