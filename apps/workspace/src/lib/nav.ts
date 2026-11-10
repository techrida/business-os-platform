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
  /**
   * The permission, or any one of a list, that lets a person see this item.
   * The server decides, as with `audience`, and passes the answer in as the predicate of
   * `visibleGroups`: this file stays free of runtime contract imports because the header title (a
   * client component) imports it. With no predicate, a gated item stays hidden (deny by default).
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
        permission: 'procurement.po.issue',
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
  return item.href !== undefined && SHIPPED_PHASES.includes(item.phase);
}

/**
 * The groups a person sees: unbuilt items stay as plain disabled rows, admin-only items go
 * unless `showAdmin`, items with a `permission` go unless `can` grants any of them (no `can` means none
 * is granted), and a group left with no items goes too.
 */
export function visibleGroups(
  showAdmin: boolean,
  can?: (permission: string) => boolean,
): readonly NavGroup[] {
  return NAV_GROUPS.map((group) => ({
    ...group,
    items: group.items.filter(
      (item) =>
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
