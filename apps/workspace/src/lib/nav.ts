/**
 * The sidebar as data. Groups and items follow the Figma sidebar (node 727:10457). Pure data
 * with no React import, so unit tests and the header title lookup can use it anywhere.
 *
 * An item is "built" when its phase is BUILT_PHASE (P0 today). Built items have an `href` and
 * render as links. Every other item has no `href`, renders disabled with a phase tag, and so
 * shows the roadmap. When a phase ships, give its items an `href` and move BUILT_PHASE.
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
  /** The phase that builds this item. */
  phase: Phase;
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

/** Items in this phase are built and linked. */
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

/** Text for the phase tag: "P2", or "Later". */
export function phaseTag(phase: Phase): string {
  return phase === 'later' ? 'Later' : phase;
}

/** Screen-reader text for the phase of an unbuilt item. */
export function phaseDescription(phase: Phase): string {
  return phase === 'later' ? 'planned for a later phase' : `planned for phase ${phase}`;
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
