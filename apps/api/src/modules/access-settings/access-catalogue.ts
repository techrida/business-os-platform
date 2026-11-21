// Pure catalogue of roles, areas, permission groups, permissions, default level rules,
// maker-checker conflict pairs, and plain-language labels for Access Settings (U20b).
// Zero database I/O; every permission in PERMISSIONS and every role in ROLE_KEYS is listed once.
import {
  type AccessAreaInfo,
  type AccessConflictRule,
  type AccessLevel,
  type AccessLevelRule,
  type AccessLevelRuleDefaults,
  type AccessPermissionGroup,
  type AccessPermissionInfo,
  type AccessRoleInfo,
  type AccessScope,
  type AccessSettingAreaKey,
  DEFAULT_ROLE_PERMISSIONS,
  LEAD_INTAKE_ROLE_KEYS,
  LEVEL_RULE_AREAS,
  type LevelRuleArea,
  type ManagerAssignmentRule,
  type Permission,
  type RoleKey,
  SOD_PERMISSIONS,
  type StaffAssignmentRule,
} from '@bos/contracts';

export type RoleCatalogueEntry = Omit<AccessRoleInfo, 'peopleCount'>;

/** All thirteen fixed roles in display order (Founder first, staff roles, then portal roles). */
export const ACCESS_ROLE_CATALOGUE: readonly RoleCatalogueEntry[] = [
  {
    key: 'founder',
    label: 'Founder',
    description: 'Full access to everything in Business OS.',
    kind: 'founder',
    locked: true,
  },
  {
    key: 'management',
    label: 'Management',
    description: 'Company-wide oversight and approvals across sales and billing.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'finance',
    label: 'Finance',
    description:
      'Issues invoices, verifies payments and vendor bank accounts, and requests payments.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'accountant',
    label: 'Accountant',
    description:
      'Prepares sales orders, drafts invoices, enters vendor bills, and records payments.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'Works leads, opportunities, customers, and quotations.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'marketing',
    label: 'Marketing',
    description: 'Creates, qualifies, and hands over leads to Sales.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'pmo',
    label: 'PMO',
    description: 'Reviews customer and vendor verification and tracks incoming sales.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'operations_head',
    label: 'Operations Head',
    description: 'Oversees operations and reads incoming sales records.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'procurement',
    label: 'Procurement',
    description: 'Handles purchase requests, sourcing, purchase orders, and vendors.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'warehouse',
    label: 'Warehouse',
    description: 'Confirms goods receipts against purchase orders.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'operations_officer',
    label: 'Operations Officer',
    description: 'Raises purchase requests and handles day-to-day operations.',
    kind: 'staff',
    locked: false,
  },
  {
    key: 'customer_user',
    label: 'Customer portal user',
    description: 'External customer contact viewing quotations and invoices in the portal.',
    kind: 'portal',
    locked: false,
  },
  {
    key: 'vendor_user',
    label: 'Vendor portal user',
    description: 'External vendor contact viewing orders and submitting bills in the portal.',
    kind: 'portal',
    locked: false,
  },
];

export const ROLE_BY_KEY: ReadonlyMap<RoleKey, RoleCatalogueEntry> = new Map(
  ACCESS_ROLE_CATALOGUE.map((role) => [role.key, role]),
);

/** The nine business areas shown on Access > By area, in display order (spec 3.1 + R2, R3). */
export const ACCESS_AREA_CATALOGUE: readonly AccessAreaInfo[] = [
  {
    key: 'leads',
    label: 'Leads',
    seePermission: 'crm.lead.read',
    actionPermissions: ['crm.lead.write', 'crm.lead.reopen'],
    hasAssignment: true,
    supportsDepartment: true,
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    seePermission: 'crm.opportunity.read',
    actionPermissions: ['crm.opportunity.write', 'crm.opportunity.reopen'],
    hasAssignment: true,
    supportsDepartment: true,
  },
  {
    key: 'quotations',
    label: 'Quotations',
    seePermission: 'quotation.read',
    actionPermissions: [
      'quotation.draft',
      'quotation.submit',
      'quotation.send',
      'quotation.record_acceptance',
      'quotation.revise',
      'quotation.cost.read',
    ],
    hasAssignment: false,
    followsArea: 'opportunities',
    supportsDepartment: true,
  },
  {
    key: 'sales_orders',
    label: 'Sales orders',
    seePermission: 'sales_order.read',
    actionPermissions: [
      'sales_order.confirm',
      'sales_order.mark_billable',
      'sales_order.delivery_release',
    ],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'invoices',
    label: 'Invoices',
    seePermission: 'invoice.read',
    actionPermissions: [
      'invoice.draft',
      'invoice.submit',
      'invoice.issue',
      'invoice.credit_note',
      'vat.sales.read',
    ],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'procurement',
    label: 'Procurement',
    seePermission: 'procurement.pr.read',
    actionPermissions: [
      'procurement.pr.create',
      'procurement.sourcing',
      'procurement.po.issue',
      'procurement.receipt.confirm',
    ],
    hasAssignment: false,
    supportsDepartment: true,
  },
  {
    key: 'payables',
    label: 'Payables',
    seePermission: 'payables.bill.read',
    actionPermissions: [
      'payables.bill.enter',
      'payables.payment.request',
      'payables.vat_register.read',
    ],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'approvals',
    label: 'Approvals',
    seePermission: 'approvals.requests.read',
    actionPermissions: [
      'approvals.requests.act',
      'approvals.requests.reroute',
      'approvals.definitions.read',
      'approvals.definitions.write',
      'approvals.definitions.publish',
      'approvals.groups.write',
      'approvals.delegations.write',
    ],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'documents',
    label: 'Documents',
    seePermission: 'documents.read',
    actionPermissions: ['documents.upload'],
    hasAssignment: false,
    supportsDepartment: false,
  },
];

export const AREA_BY_KEY: ReadonlyMap<AccessSettingAreaKey, AccessAreaInfo> = new Map(
  ACCESS_AREA_CATALOGUE.map((area) => [area.key, area]),
);

export const AREA_BY_SEE_PERMISSION: ReadonlyMap<Permission, AccessAreaInfo> = new Map(
  ACCESS_AREA_CATALOGUE.map((area) => [area.seePermission, area]),
);

/** Singular lowercase noun per area for plain-language warnings (W5). */
export const AREA_SINGULAR_NOUN: Readonly<Record<AccessSettingAreaKey, string>> = {
  leads: 'lead',
  opportunities: 'opportunity',
  quotations: 'quotation',
  sales_orders: 'sales order',
  invoices: 'invoice',
  procurement: 'purchase request',
  payables: 'vendor bill',
  approvals: 'approval request',
  documents: 'document',
};

/** Plural lowercase noun per area for plain-language warnings and summaries. */
export const AREA_PLURAL_NOUN: Readonly<Record<AccessSettingAreaKey, string>> = {
  leads: 'leads',
  opportunities: 'opportunities',
  quotations: 'quotations',
  sales_orders: 'sales orders',
  invoices: 'invoices',
  procurement: 'purchase requests',
  payables: 'vendor bills',
  approvals: 'approval requests',
  documents: 'documents',
};

/**
 * The department-reach switch of each area as the contracts define it (`LEVEL_RULE_AREAS`): its see
 * permission, the write it pairs with (`editPermission`), whether its records carry a department,
 * and the default switches. Migration 0088 and the role cache's code defaults derive from the same
 * list, so Settings > Access reads it rather than keep a copy. `ACCESS_AREA_CATALOGUE` repeats
 * `seePermission` and `supportsDepartment` for the wire shape; a test holds the two equal.
 */
export const LEVEL_RULE_AREA_BY_KEY: ReadonlyMap<AccessSettingAreaKey, LevelRuleArea> = new Map(
  (LEVEL_RULE_AREAS as readonly LevelRuleArea[]).map((area) => [
    area.key as AccessSettingAreaKey,
    area,
  ]),
);

/** Default manager/head department-level switches per area (D50, D51). */
export const DEFAULT_LEVEL_RULES: Readonly<Record<AccessSettingAreaKey, AccessLevelRuleDefaults>> =
  Object.fromEntries(
    [...LEVEL_RULE_AREA_BY_KEY].map(([key, area]) => [
      key,
      {
        managersSeeDepartment: area.managersSeeDepartment,
        headsSeeDepartment: area.headsSeeDepartment,
      },
    ]),
  ) as Record<AccessSettingAreaKey, AccessLevelRuleDefaults>;

/**
 * The permissions one area's switch writes level rows for: the see permission and, where the area
 * pairs one, the edit permission (D50: a Sales manager hands a staff member's lead over, which is a
 * write). Empty for an area whose records carry no department.
 */
export function levelRulePermissions(areaKey: AccessSettingAreaKey): Permission[] {
  const area = LEVEL_RULE_AREA_BY_KEY.get(areaKey);
  if (area === undefined || !area.supportsDepartment) return [];
  return area.editPermission === undefined
    ? [area.seePermission]
    : [area.seePermission, area.editPermission];
}

/** The area whose switch governs a see or edit permission, and which of the two it is. */
export const LEVEL_AREA_BY_PERMISSION: ReadonlyMap<
  Permission,
  { area: AccessSettingAreaKey; edit: boolean }
> = new Map(
  [...LEVEL_RULE_AREA_BY_KEY].flatMap(([key, area]) => {
    if (!area.supportsDepartment) return [];
    const entries: [Permission, { area: AccessSettingAreaKey; edit: boolean }][] = [
      [area.seePermission, { area: key, edit: false }],
    ];
    if (area.editPermission !== undefined) {
      entries.push([area.editPermission, { area: key, edit: true }]);
    }
    return entries;
  }),
);

/**
 * Whether an area switch widens `role`'s grant of `scope` on `permission` to the department, the
 * rule migration 0088 and `DEFAULT_ROLE_PERMISSION_LEVELS` apply: staff roles only (the Founder
 * reaches everything, portal users hold no department), a grant the role already holds below the
 * department (a level row never creates access), and no edit row for the lead intake roles, which
 * hold the write only to start a lead for Sales (the contracts' `editsArea`).
 */
export function levelSwitchWidens(
  role: RoleKey,
  permission: Permission,
  scope: AccessScope | null,
): boolean {
  const entry = LEVEL_AREA_BY_PERMISSION.get(permission);
  if (entry === undefined) return false;
  if (ROLE_BY_KEY.get(role)?.kind !== 'staff') return false;
  if (scope === null || reachRank(scope) >= reachRank('department')) return false;
  if (entry.edit && (LEAD_INTAKE_ROLE_KEYS as readonly RoleKey[]).includes(role)) return false;
  return true;
}

/**
 * Whether a member of `level` gets the area's department row. The role cache gives a member the
 * most senior row at or below their level, so a head with no head row keeps the manager row: heads
 * reach the department when either switch is on.
 */
export function levelReachesDepartment(
  level: AccessLevel,
  rule: Pick<AccessLevelRule, 'managersSeeDepartment' | 'headsSeeDepartment'> | undefined,
): boolean {
  if (rule === undefined) return false;
  switch (level) {
    case 'staff':
      return false;
    case 'manager':
      return rule.managersSeeDepartment;
    case 'head':
      return rule.headsSeeDepartment || rule.managersSeeDepartment;
  }
}

/** One `app.role_permission_levels` row the switches imply; the scope is always the department. */
export interface ImpliedLevelRow {
  role: RoleKey;
  permission: Permission;
  minLevel: 'manager' | 'head';
}

/**
 * Every level row the given grants and switches imply: per area switch that is on, a row at that
 * level for each of the area's see and edit permissions and each role the switch widens there.
 * Materialising, reconciling and Check a person all go through this, and with the default grants
 * and switches it equals `DEFAULT_ROLE_PERMISSION_LEVELS`.
 */
export function impliedLevelRows(
  grantMap: ReadonlyMap<string, AccessScope | null>,
  levelRules: readonly Pick<
    AccessLevelRule,
    'area' | 'managersSeeDepartment' | 'headsSeeDepartment'
  >[],
): ImpliedLevelRow[] {
  const rows: ImpliedLevelRow[] = [];
  for (const rule of levelRules) {
    const permissions = levelRulePermissions(rule.area);
    for (const permission of permissions) {
      for (const role of ACCESS_ROLE_CATALOGUE) {
        const scope = grantMap.get(`${role.key}:${permission}`) ?? null;
        if (!levelSwitchWidens(role.key, permission, scope)) continue;
        if (rule.managersSeeDepartment) {
          rows.push({ role: role.key, permission, minLevel: 'manager' });
        }
        if (rule.headsSeeDepartment) rows.push({ role: role.key, permission, minLevel: 'head' });
      }
    }
  }
  return rows;
}

/**
 * Every permission in PERMISSIONS grouped in display order for Access > By role.
 * The nine area groups come first, followed by the remaining operational, admin, and portal groups.
 */
export const ACCESS_PERMISSION_GROUPS: readonly AccessPermissionGroup[] = [
  {
    key: 'leads',
    label: 'Leads',
    permissions: ['crm.lead.read', 'crm.lead.write', 'crm.lead.reopen'],
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    permissions: ['crm.opportunity.read', 'crm.opportunity.write', 'crm.opportunity.reopen'],
  },
  {
    key: 'quotations',
    label: 'Quotations',
    permissions: [
      'quotation.read',
      'quotation.draft',
      'quotation.submit',
      'quotation.send',
      'quotation.record_acceptance',
      'quotation.revise',
      'quotation.cost.read',
    ],
  },
  {
    key: 'sales_orders',
    label: 'Sales orders',
    permissions: [
      'sales_order.read',
      'sales_order.confirm',
      'sales_order.mark_billable',
      'sales_order.delivery_release',
    ],
  },
  {
    key: 'invoices',
    label: 'Invoices',
    permissions: [
      'invoice.read',
      'invoice.draft',
      'invoice.submit',
      'invoice.issue',
      'invoice.credit_note',
      'vat.sales.read',
    ],
  },
  {
    key: 'procurement',
    label: 'Procurement',
    permissions: [
      'procurement.pr.read',
      'procurement.pr.create',
      'procurement.sourcing',
      'procurement.po.issue',
      'procurement.receipt.confirm',
    ],
  },
  {
    key: 'payables',
    label: 'Payables',
    permissions: [
      'payables.bill.read',
      'payables.bill.enter',
      'payables.payment.request',
      'payables.vat_register.read',
    ],
  },
  {
    key: 'approvals',
    label: 'Approvals',
    permissions: [
      'approvals.requests.read',
      'approvals.requests.act',
      'approvals.requests.reroute',
      'approvals.definitions.read',
      'approvals.definitions.write',
      'approvals.definitions.publish',
      'approvals.groups.write',
      'approvals.delegations.write',
    ],
  },
  { key: 'documents', label: 'Documents', permissions: ['documents.read', 'documents.upload'] },
  {
    key: 'customers',
    label: 'Customers',
    permissions: [
      'customer.read',
      'customer.write',
      'customer.merge',
      'customers.credit_limit.write',
      'customers.owner.write',
    ],
  },
  {
    key: 'verification',
    label: 'Verification',
    permissions: ['verification.read', 'verification.review'],
  },
  {
    key: 'payments_receivables',
    label: 'Payments and receivables',
    permissions: [
      'payment.read',
      'payment.record',
      'payment.verify',
      'payment.allocate',
      'ar.read',
      'credit.override',
    ],
  },
  {
    key: 'vendors',
    label: 'Vendors',
    permissions: [
      'vendor.read',
      'vendor.write',
      'vendor.activate',
      'vendor.bank.propose',
      'vendor.bank.verify',
    ],
  },
  { key: 'memos', label: 'Memos', permissions: ['memo.read', 'memo.create', 'memo.update'] },
  {
    key: 'administration',
    label: 'Administration',
    permissions: [
      'admin.users.read',
      'admin.users.invite',
      'profile.avatar.write',
      'admin.roles.read',
      'admin.roles.write',
      'admin.settings.write',
      'settings.finance.write',
      'settings.fx_rate.write',
      'audit.read',
      'email_delivery.read',
      'email_delivery.resend',
    ],
  },
  {
    key: 'portal',
    label: 'Portal access',
    permissions: [
      'portal.quotation.read',
      'portal.quotation.respond',
      'portal.invoice.read',
      'portal.payment.submit',
      'portal.vendor.read',
      'portal.vendor.submit',
    ],
  },
];

const SOD_SET: ReadonlySet<Permission> = new Set(SOD_PERMISSIONS);

const RECORD_CRM_READ: AccessScope[] = ['assigned', 'own', 'department', 'all'];
const RECORD_DEPT: AccessScope[] = ['own', 'department', 'all'];
const RECORD_NO_DEPT: AccessScope[] = ['own', 'all'];
const ON_OFF_STAFF: AccessScope[] = ['all'];
const PORTAL_ONLY: AccessScope[] = ['customer_org'];

function perm(
  key: Permission,
  label: string,
  kind: AccessPermissionInfo['kind'],
  staffScopes: AccessScope[],
  portalScopes: AccessScope[],
  risk?: string,
): AccessPermissionInfo {
  return {
    key,
    label,
    kind,
    ...(risk === undefined ? {} : { risk }),
    separationOfDuties: SOD_SET.has(key),
    scopesFor: { staff: staffScopes, portal: portalScopes },
  };
}

/** Catalogue entry for every one of the 73 permissions in PERMISSIONS. */
export const ACCESS_PERMISSION_CATALOGUE: readonly AccessPermissionInfo[] = [
  // Leads
  perm('crm.lead.read', 'See leads', 'record', RECORD_CRM_READ, []),
  perm('crm.lead.write', 'Create and edit leads', 'record', RECORD_DEPT, []),
  // Check a person lists actions by label, so the label says the level the code also requires.
  perm(
    'crm.lead.reopen',
    'Reopen lost leads (managers and heads only)',
    'record',
    RECORD_DEPT,
    [],
    'Only managers, heads, and Founders can reopen, even when their role has this.',
  ),
  // Opportunities
  perm('crm.opportunity.read', 'See opportunities', 'record', RECORD_CRM_READ, []),
  perm('crm.opportunity.write', 'Create and edit opportunities', 'record', RECORD_DEPT, []),
  perm(
    'crm.opportunity.reopen',
    'Reopen lost opportunities (managers and heads only)',
    'record',
    RECORD_DEPT,
    [],
    'Only managers, heads, and Founders can reopen, even when their role has this.',
  ),
  // Quotations
  perm('quotation.read', 'See quotations', 'record', RECORD_DEPT, []),
  perm('quotation.draft', 'Draft quotations', 'record', RECORD_DEPT, []),
  perm('quotation.submit', 'Submit quotations for approval', 'record', RECORD_DEPT, []),
  perm('quotation.send', 'Send quotations to customers', 'record', RECORD_DEPT, []),
  perm('quotation.record_acceptance', 'Record customer acceptance', 'record', RECORD_DEPT, []),
  perm('quotation.revise', 'Revise quotations', 'record', RECORD_DEPT, []),
  perm(
    'quotation.cost.read',
    'See cost and margin',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Reveals internal unit costs and profit margins on quotations.',
  ),
  // Sales orders
  perm('sales_order.read', 'See sales orders', 'record', RECORD_NO_DEPT, []),
  perm('sales_order.confirm', 'Confirm sales orders', 'onOff', ON_OFF_STAFF, []),
  perm('sales_order.mark_billable', 'Mark schedule lines billable', 'onOff', ON_OFF_STAFF, []),
  perm(
    'sales_order.delivery_release',
    'Release a delivery hold',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Lets a confirmed order be delivered before its advance is paid. Finance releases up to the delivery-hold amount, Management above it, the Founder at any amount, and never the person who created the order, unless that person is a Founder and nobody else may release it: then they give a written reason.',
  ),
  // Invoices
  perm('invoice.read', 'See invoices', 'record', RECORD_NO_DEPT, []),
  perm('invoice.draft', 'Draft invoices', 'onOff', ON_OFF_STAFF, []),
  perm('invoice.submit', 'Submit invoices for approval', 'onOff', ON_OFF_STAFF, []),
  perm(
    'invoice.issue',
    'Issue approved invoices',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Finalises invoices for customer billing and tax reporting.',
  ),
  perm(
    'invoice.credit_note',
    'Issue credit and debit notes',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Adjusts billed amounts on issued invoices.',
  ),
  perm(
    'vat.sales.read',
    'See the sales VAT register',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Lists issued tax invoices, credit notes and debit notes with their VAT, and exports them to CSV.',
  ),
  // Procurement
  perm('procurement.pr.read', 'See purchase requests', 'record', RECORD_DEPT, []),
  perm('procurement.pr.create', 'Create purchase requests', 'record', RECORD_DEPT, []),
  perm('procurement.sourcing', 'Run vendor sourcing and quotes', 'onOff', ON_OFF_STAFF, []),
  perm('procurement.po.issue', 'Issue purchase orders', 'onOff', ON_OFF_STAFF, []),
  perm('procurement.receipt.confirm', 'Confirm goods receipts', 'onOff', ON_OFF_STAFF, []),
  // Payables
  perm('payables.bill.read', 'See vendor bills', 'record', RECORD_NO_DEPT, []),
  perm('payables.bill.enter', 'Enter vendor bills', 'onOff', ON_OFF_STAFF, []),
  perm(
    'payables.payment.request',
    'Request vendor payments',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Starts outgoing payment requests for approved vendor bills.',
  ),
  perm('payables.vat_register.read', 'See the VAT register', 'onOff', ON_OFF_STAFF, []),
  // Approvals
  perm('approvals.requests.read', 'See approval requests', 'record', RECORD_NO_DEPT, []),
  perm(
    'approvals.requests.act',
    'Approve or reject requests',
    'onOff',
    ON_OFF_STAFF,
    [],
    'The person who prepared a record still cannot approve it.',
  ),
  perm(
    'approvals.requests.reroute',
    'Reassign approval steps',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Redirects pending approval steps to another eligible approver.',
  ),
  perm('approvals.definitions.read', 'See approval workflows', 'onOff', ON_OFF_STAFF, []),
  perm(
    'approvals.definitions.write',
    'Edit approval workflows',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Changes who must approve quotes, invoices, and payments.',
  ),
  perm(
    'approvals.definitions.publish',
    'Publish approval workflows',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Puts a saved workflow draft in use. Nobody can publish a draft they saved themselves, unless they are a Founder and nobody else may publish: then they give a written reason.',
  ),
  perm('approvals.groups.write', 'Manage approval groups', 'onOff', ON_OFF_STAFF, []),
  perm('approvals.delegations.write', 'Manage approval delegations', 'onOff', ON_OFF_STAFF, []),
  // Documents
  perm('documents.read', 'See documents', 'record', RECORD_NO_DEPT, []),
  perm('documents.upload', 'Upload documents', 'record', RECORD_NO_DEPT, []),
  // Customers
  // Marketing sees only the customers it owns (D55), so this is a reach, not just an on/off switch.
  perm('customer.read', 'See customers', 'record', RECORD_NO_DEPT, []),
  perm('customer.write', 'Create and edit customers', 'onOff', ON_OFF_STAFF, []),
  perm(
    'customer.merge',
    'Merge duplicate customers',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Combines two customer records into one.',
  ),
  perm(
    'customers.credit_limit.write',
    'Set customer credit limits',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Sets how much a customer may owe before new deals go on credit hold.',
  ),
  perm('customers.owner.write', "Change a customer's owner", 'onOff', ON_OFF_STAFF, []),
  // Verification
  perm('verification.read', 'See verification checks', 'record', RECORD_NO_DEPT, []),
  perm(
    'verification.review',
    'Review and decide verification checks',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Approves or rejects customer and vendor verification cases.',
  ),
  // Payments and receivables
  perm('payment.read', 'See customer payments', 'onOff', ON_OFF_STAFF, []),
  perm('payment.record', 'Record customer payments', 'onOff', ON_OFF_STAFF, []),
  perm(
    'payment.verify',
    'Verify customer payments',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Confirms incoming customer payments as verified.',
  ),
  perm('payment.allocate', 'Allocate payments to invoices', 'onOff', ON_OFF_STAFF, []),
  perm('ar.read', 'See receivables aging', 'onOff', ON_OFF_STAFF, []),
  perm(
    'credit.override',
    'Override a credit hold',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Lets a deal go ahead to a sales order although the customer owes more than its credit limit.',
  ),
  // Vendors
  perm('vendor.read', 'See vendors', 'onOff', ON_OFF_STAFF, []),
  perm('vendor.write', 'Create and edit vendors', 'onOff', ON_OFF_STAFF, []),
  perm(
    'vendor.activate',
    'Activate approved vendors',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Enables a vendor for purchase orders and billing.',
  ),
  perm('vendor.bank.propose', 'Propose vendor bank accounts', 'onOff', ON_OFF_STAFF, []),
  perm(
    'vendor.bank.verify',
    'Verify vendor bank accounts',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Confirms vendor bank details before payments can be sent.',
  ),
  // Memos
  perm('memo.read', 'See memos', 'record', RECORD_DEPT, []),
  perm('memo.create', 'Create memos', 'record', RECORD_DEPT, []),
  perm('memo.update', 'Edit memos', 'record', RECORD_DEPT, []),
  // Administration
  perm('admin.users.read', 'See users', 'onOff', ON_OFF_STAFF, []),
  perm(
    'admin.users.invite',
    'Invite users',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Invites new people into the company.',
  ),
  perm('profile.avatar.write', 'Set profile pictures', 'record', RECORD_NO_DEPT, []),
  perm('admin.roles.read', 'See access settings', 'onOff', ON_OFF_STAFF, []),
  perm(
    'admin.roles.write',
    'Change access settings',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Only Founders can change access settings.',
  ),
  perm(
    'admin.settings.write',
    'Change company settings',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Edits company profile, tax, and numbering settings.',
  ),
  perm(
    'settings.finance.write',
    'Change tax, numbering, and terms settings',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Edits tax and numbering settings, number series, and the saved terms.',
  ),
  perm(
    'settings.fx_rate.write',
    'Change exchange rates',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Sets the exchange rates used to convert foreign-currency amounts.',
  ),
  perm(
    'audit.read',
    'Read the audit trail',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Views the full history of changes across the company.',
  ),
  perm(
    'email_delivery.read',
    'See the email delivery log',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Sees every email the company sent or failed to send, with its recipient and subject.',
  ),
  perm(
    'email_delivery.resend',
    'Resend failed emails',
    'onOff',
    ON_OFF_STAFF,
    [],
    'Sends a failed or bounced email again from the delivery log.',
  ),
  // Portal access
  perm('portal.quotation.read', 'View company quotations in portal', 'portal', [], PORTAL_ONLY),
  perm('portal.quotation.respond', 'Respond to quotations in portal', 'portal', [], PORTAL_ONLY),
  perm(
    'portal.invoice.read',
    'View company invoices and milestones in portal',
    'portal',
    [],
    PORTAL_ONLY,
  ),
  perm('portal.payment.submit', 'Submit payment proof in portal', 'portal', [], PORTAL_ONLY),
  perm('portal.vendor.read', 'View purchase orders and bills in portal', 'portal', [], PORTAL_ONLY),
  perm('portal.vendor.submit', 'Submit bills in portal', 'portal', [], PORTAL_ONLY),
];

export const PERMISSION_BY_KEY: ReadonlyMap<Permission, AccessPermissionInfo> = new Map(
  ACCESS_PERMISSION_CATALOGUE.map((p) => [p.key, p]),
);

export interface MakerCheckerConflictDef extends AccessConflictRule {
  actionText: string;
  noun: string;
}

/** Maker-and-checker pairs checked by warning W4 (spec 8.1). */
export const MAKER_CHECKER_CONFLICTS: readonly MakerCheckerConflictDef[] = [
  {
    permissions: ['invoice.submit', 'invoice.issue'],
    message: 'Submitting and issuing invoices are normally kept separate.',
    actionText: 'submit and issue an invoice',
    noun: 'invoice',
  },
  {
    permissions: ['payment.record', 'payment.verify'],
    message: 'Recording and verifying payments are normally kept separate.',
    actionText: 'record and verify a payment',
    noun: 'payment',
  },
  {
    permissions: ['vendor.bank.propose', 'vendor.bank.verify'],
    message: 'Proposing and verifying vendor bank accounts are normally kept separate.',
    actionText: 'propose and verify a vendor bank account',
    noun: 'bank account',
  },
  {
    permissions: ['payables.bill.enter', 'payables.payment.request'],
    message: 'Entering vendor bills and requesting payments are normally kept separate.',
    actionText: 'enter a bill and request its payment',
    noun: 'bill',
  },
];

export const ACCESS_CONFLICTS: readonly AccessConflictRule[] = MAKER_CHECKER_CONFLICTS.map(
  ({ permissions, message }) => ({ permissions, message }),
);

/** Administration permissions that trigger W3 (`confirm`) when newly given to a non-Founder role. */
export const ADMIN_CONFIRM_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'admin.users.invite',
  'admin.settings.write',
  'settings.finance.write',
  'settings.fx_rate.write',
  'audit.read',
  'email_delivery.read',
  'email_delivery.resend',
]);

/** Reach rank in strict order per Review R1 (`null < assigned < own < department < all`). */
export const REACH_RANK: Readonly<Record<AccessScope, number>> = {
  assigned: 1,
  own: 2,
  customer_org: 2,
  department: 3,
  all: 4,
};

export function reachRank(scope: AccessScope | null): number {
  return scope === null ? 0 : REACH_RANK[scope];
}

/** Plain-language label for a reach (spec 3.2; never uses the word "scope"). */
export function reachLabel(
  scope: AccessScope | null,
  kind: AccessPermissionInfo['kind'] = 'record',
): string {
  if (scope === null) return kind === 'onOff' ? 'Off' : 'Nothing';
  if (kind === 'onOff') return 'On';
  switch (scope) {
    case 'assigned':
      return 'Only work given to them';
    case 'own':
      return 'Their own';
    case 'department':
      return 'Their department';
    case 'customer_org':
      return 'Their company only';
    case 'all':
      return 'Everything';
  }
}

export function roleLabel(role: RoleKey): string {
  return ROLE_BY_KEY.get(role)?.label ?? role;
}

export function permissionLabel(permission: Permission): string {
  return PERMISSION_BY_KEY.get(permission)?.label ?? permission;
}

export function staffAssignmentRuleLabel(rule: StaffAssignmentRule): string {
  switch (rule) {
    case 'self_and_peers':
      return 'Themselves and same-level colleagues in their department';
    case 'self_only':
      return 'Only themselves';
    case 'any_at_or_below':
      return 'Anyone in their department at or below their level';
  }
}

export function managerAssignmentRuleLabel(rule: ManagerAssignmentRule): string {
  switch (rule) {
    case 'any_at_or_below':
      return 'Anyone in their department at or below their level';
    case 'self_and_staff':
      return 'Only themselves and people below their level';
  }
}

/** Default scope for a (role, permission) pair from DEFAULT_ROLE_PERMISSIONS, or null if absent. */
export function defaultScopeFor(role: RoleKey, permission: Permission): AccessScope | null {
  return DEFAULT_ROLE_PERMISSIONS[role][permission] ?? null;
}

/** Whether `scope` is permitted for `(role, permission)` under the catalogue rules. */
export function isScopeAllowedForRole(
  role: RoleKey,
  permission: Permission,
  scope: AccessScope | null,
): boolean {
  if (scope === null) return true;
  const roleInfo = ROLE_BY_KEY.get(role);
  const permInfo = PERMISSION_BY_KEY.get(permission);
  if (!roleInfo || !permInfo) return false;
  if (roleInfo.kind === 'founder') return scope === 'all';
  const allowed = roleInfo.kind === 'portal' ? permInfo.scopesFor.portal : permInfo.scopesFor.staff;
  return allowed.includes(scope);
}
