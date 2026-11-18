/**
 * The sidebar as data. Groups and items follow the Figma sidebar (node 727:10457). Pure data
 * with no React import, so unit tests and the header title lookup can use it anywhere.
 *
 * An item is "built" when its phase is BUILT_PHASE. Built items have an `href` and render as
 * links. Phase metadata is internal. When a phase ships, give its items an `href` and move
 * BUILT_PHASE.
 *
 * "Estimates" is left out on purpose: decision D3 merged it into Quotations.
 */

export type Phase = 'P0' | 'P1' | 'P2' | 'P3' | 'P4' | 'later';

/** Icons the sidebar can show. The drawings live in components/ui/icon.tsx. */
export type NavIconName =
  | 'home'
  | 'layers'
  | 'user'
  | 'users'
  | 'briefcase'
  | 'building'
  | 'target'
  | 'trending-up'
  | 'file-text'
  | 'list-checks'
  | 'kanban'
  | 'check-circle'
  | 'receipt'
  | 'repeat'
  | 'credit-card'
  | 'banknote'
  | 'settings'
  | 'help-circle';

export interface NavItem {
  label: string;
  /** Present only on built items. */
  href?: string;
  icon: NavIconName;
  /** Internal: the phase that will enable this item. Never shown to users. */
  phase: Phase;
  /**
   * Optional number shown in a pill at the row's end (the Figma "Organizations 4"). Only built
   * items show it, and only when it is above zero. P0 has nothing to count, so no item sets it.
   */
  count?: number;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

/** Internal: items in this phase are built and linked. Never shown to users. */
export const BUILT_PHASE: Phase = 'P0';

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: 'Overview',
    items: [{ label: 'Overview', href: '/', icon: 'home', phase: 'P0' }],
  },
  {
    label: 'Organization',
    items: [
      { label: 'Department', icon: 'layers', phase: 'P1' },
      { label: 'User', icon: 'user', phase: 'P1' },
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
    items: [
      { label: 'Sales Pipeline', icon: 'kanban', phase: 'P2' },
      { label: 'Approvals', icon: 'check-circle', phase: 'P1' },
    ],
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
      { label: 'Settings', icon: 'settings', phase: 'P1' },
      { label: 'Help', icon: 'help-circle', phase: 'later' },
    ],
  },
];

export const APP_NAME = 'Business OS';

/** True when the item is built and links somewhere. */
export function isBuilt(item: NavItem): item is NavItem & { href: string } {
  return item.phase === BUILT_PHASE && item.href !== undefined;
}

/** Page title for a route: the label of the built item that owns the path, else the app name. */
export function titleForPath(pathname: string): string {
  for (const group of NAV_GROUPS) {
    for (const item of group.items) {
      if (isBuilt(item) && item.href === pathname) return item.label;
    }
  }
  return APP_NAME;
}

/** Filter already-authorized, built navigation by group or destination name. */
export function searchNavGroups(groups: readonly NavGroup[], query: string): readonly NavGroup[] {
  const term = query.trim().toLowerCase();
  return groups
    .map((group) => ({
      ...group,
      items: group.items.filter(
        (item) =>
          isBuilt(item) &&
          (group.label.toLowerCase().includes(term) || item.label.toLowerCase().includes(term)),
      ),
    }))
    .filter((group) => group.items.length > 0);
}
