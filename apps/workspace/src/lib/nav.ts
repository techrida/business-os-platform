/**
 * The sidebar as data. Groups and items follow the Figma sidebar (node 727:10457) and the P1
 * screen map. Pure data with no React import, so unit tests and client components (the
 * shell's navigation search and nav links) can use it anywhere.
 *
 * An item is "built" when it has an `href`: it renders as a link. Unbuilt items stay out of
 * navigation. `phase` and SHIPPED_PHASES are internal and never shown to users.
 * When an item ships, give it an `href` and a phase in SHIPPED_PHASES; nav.test.ts keeps
 * the two in step.
 *
 * Items with `audience: 'admin'` are shown only to people who can open at least one settings
 * section. The sidebar decides that from the live grants (`visibleSettingsGroups`, the same check
 * the Settings page makes before it redirects to denied) and passes the answer in:
 * this file stays free of server code because client components (shell-nav.tsx, nav-link.tsx)
 * import it.
 *
 * "Estimates" is left out on purpose: decision D3 merged it into Quotations. "Approvals" and
 * "User" are not listed: they are Work > Inbox and Settings > Organisation. Organisation items
 * (Users, Departments, Access, Approval workflows) live under Settings (settings-nav.ts).
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
  /**
   * The permission, or any one of a list, that lets a person see this item.
   * The server decides, as with `audience`, and passes the answer in as the predicate of
   * `visibleGroups`: this file stays free of runtime contract imports because client components
   * (shell-nav.tsx, nav-link.tsx) import it. With no predicate, a gated item stays hidden (deny by
   * default).
   * The pages and the API still enforce the permission themselves.
   */
  permission?: string | readonly string[];
}

export interface NavGroup {
  label: string;
  items: readonly NavItem[];
}

/** Internal phases whose items may be built and linked. Never shown to users. */
export const SHIPPED_PHASES: readonly Phase[] = ['P0', 'P1', 'P2', 'P3', 'P4'];

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
    label: 'CRM',
    items: [
      // The Figma sidebar says "Organizations"; the brief and ADR 0027 call the record a customer.
      {
        label: 'Customers',
        href: '/customers',
        icon: 'building',
        phase: 'P2',
        permission: 'customer.read',
      },
      { label: 'Contacts', icon: 'users', phase: 'P2' },
      {
        label: 'Leads',
        href: '/leads',
        icon: 'target',
        phase: 'P2',
        permission: 'crm.lead.read',
      },
      {
        label: 'Opportunities',
        href: '/opportunities',
        icon: 'trending-up',
        phase: 'P2',
        permission: 'crm.opportunity.read',
      },
      // The lost-deal report reads only deals, so it follows the deal read grant, as its API does.
      {
        label: 'Lost deals',
        href: '/reports/lost-deals',
        icon: 'trending-up',
        phase: 'P2',
        permission: 'crm.opportunity.read',
      },
      {
        label: 'Quotations',
        href: '/quotations',
        icon: 'file-text',
        phase: 'P2',
        permission: 'quotation.read',
      },
      // Not in Figma: the KYB review queue sits next to the customers it verifies.
      {
        label: 'Verification',
        href: '/verification',
        icon: 'shield-check',
        phase: 'P2',
        permission: 'verification.read',
      },
      // No activity permission exists in the contracts yet: the feed covers leads and opportunities,
      // so it follows the lead read grant (deny by default). The API still decides every call.
      {
        label: 'Activities & Tasks',
        href: '/activities',
        icon: 'list-checks',
        phase: 'P2',
        permission: 'crm.lead.read',
      },
    ],
  },
  {
    label: 'Sales Management',
    items: [{ label: 'Sales Pipeline', icon: 'kanban', phase: 'P2' }],
  },
  {
    label: 'Sales',
    items: [
      {
        label: 'Sales Orders',
        href: '/sales-orders',
        icon: 'file-text',
        phase: 'P3',
        permission: 'sales_order.read',
      },
      {
        label: 'Invoices',
        href: '/invoices',
        icon: 'receipt',
        phase: 'P3',
        permission: 'invoice.read',
      },
      {
        label: 'Sales VAT register',
        href: '/invoices/vat-register',
        icon: 'file-text',
        phase: 'P3',
        permission: 'vat.sales.read',
      },
      // Not in the PRD yet (see the Figma notes), so parked at "later" until it is confirmed.
      { label: 'Recurring Invoices', icon: 'repeat', phase: 'later' },
    ],
  },
  {
    label: 'Payments',
    items: [
      {
        label: 'Payments',
        href: '/payments',
        icon: 'banknote',
        phase: 'P3',
        permission: 'payment.read',
      },
      {
        label: 'Receivables',
        href: '/receivables/aging',
        icon: 'trending-up',
        phase: 'P3',
        permission: 'ar.read',
      },
      // No screen yet: methods are fixed in the contract, so it waits for a later phase.
      { label: 'Payment Methods', icon: 'credit-card', phase: 'later' },
    ],
  },
  {
    label: 'Purchases',
    items: [
      {
        label: 'Purchase requests',
        href: '/procurement/requests',
        icon: 'list-checks',
        phase: 'P4',
        permission: 'procurement.pr.read',
      },
      {
        label: 'Requests for quotation',
        href: '/procurement/rfqs',
        icon: 'file-text',
        phase: 'P4',
        permission: 'procurement.sourcing',
      },
      {
        label: 'Purchase orders',
        href: '/procurement/orders',
        icon: 'file-text',
        phase: 'P4',
        permission: [
          'procurement.po.issue',
          'payables.bill.enter',
          'payables.bill.read',
          'procurement.receipt.confirm',
        ],
      },
      {
        label: 'Receipts',
        href: '/procurement/receipts',
        icon: 'receipt',
        phase: 'P4',
        permission: [
          'procurement.receipt.confirm',
          'procurement.po.issue',
          'procurement.pr.create',
        ],
      },
      {
        label: 'Vendors',
        href: '/vendors',
        icon: 'building',
        phase: 'P4',
        permission: 'vendor.read',
      },
    ],
  },
  {
    label: 'Payables',
    items: [
      {
        label: 'Bill inbox',
        href: '/payables/inbox',
        icon: 'inbox',
        phase: 'P4',
        permission: 'payables.bill.enter',
      },
      {
        label: 'Bills',
        href: '/payables/bills',
        icon: 'receipt',
        phase: 'P4',
        permission: 'payables.bill.read',
      },
      {
        label: 'Payment requests',
        href: '/payables/payment-requests',
        icon: 'banknote',
        phase: 'P4',
        permission: 'payables.payment.request',
      },
      {
        label: 'Purchase VAT register',
        href: '/payables/vat-register',
        icon: 'file-text',
        phase: 'P4',
        permission: 'payables.vat_register.read',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        label: 'Settings',
        href: '/settings',
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
  return item.href !== undefined && SHIPPED_PHASES.includes(item.phase);
}

/**
 * Keep built destinations the user can see and omit groups with no visible items. Admin-only
 * items need `showAdmin`; items with a `permission` need `can` to grant it (no `can` grants none).
 */
export function visibleGroups(
  showAdmin: boolean,
  can?: (permission: string) => boolean,
): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
        isBuilt(item) &&
        (item.audience !== 'admin' || showAdmin) &&
        (item.permission === undefined ||
          (typeof item.permission === 'string' ? [item.permission] : item.permission).some(
            (permission) => can?.(permission) === true,
          )),
    ),
  })).filter((group) => group.items.length > 0);
}

/** True when `pathname` is the item's page or one under it (`/inbox` owns `/inbox/abc`). */
export function ownsPath(href: string, pathname: string): boolean {
  return href === '/' ? pathname === '/' : pathname === href || pathname.startsWith(`${href}/`);
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
