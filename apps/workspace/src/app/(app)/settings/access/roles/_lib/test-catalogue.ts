// A small access catalogue shaped like `GET /v1/admin/access`, shared by the By role and Check a
// person tests. Built through the contract schema so a drifting shape fails here first.
import {
  AccessCatalogueResponseSchema,
  type AccessCatalogueResponse,
  type AccessScope,
  type Permission,
  type RoleKey,
} from '@bos/contracts';

const grant = (
  role: RoleKey,
  permission: Permission,
  scope: AccessScope | null,
  defaultScope: AccessScope | null = scope,
) => ({ role, permission, scope, defaultScope, isDefault: scope === defaultScope });

const PERMISSIONS = [
  {
    key: 'crm.lead.read',
    label: 'See leads',
    kind: 'record',
    separationOfDuties: false,
    scopesFor: { staff: ['assigned', 'own', 'department', 'all'], portal: [] },
  },
  {
    key: 'crm.lead.write',
    label: 'Create and edit leads',
    kind: 'record',
    separationOfDuties: false,
    scopesFor: { staff: ['own', 'department', 'all'], portal: [] },
  },
  {
    key: 'invoice.read',
    label: 'See invoices',
    kind: 'record',
    separationOfDuties: false,
    scopesFor: { staff: ['own', 'all'], portal: [] },
  },
  {
    key: 'invoice.issue',
    label: 'Issue an invoice',
    kind: 'onOff',
    separationOfDuties: true,
    scopesFor: { staff: ['all'], portal: [] },
  },
  {
    key: 'admin.users.invite',
    label: 'Invite users',
    kind: 'onOff',
    risk: 'Lets this role add people to the company.',
    separationOfDuties: false,
    scopesFor: { staff: ['all'], portal: [] },
  },
  {
    key: 'portal.quotation.read',
    label: 'View company quotations in portal',
    kind: 'portal',
    separationOfDuties: false,
    scopesFor: { staff: [], portal: ['customer_org'] },
  },
] as const;

const ROLES = [
  {
    key: 'founder',
    label: 'Founder',
    description: 'Full access to everything in Business OS.',
    kind: 'founder',
    locked: true,
    peopleCount: 1,
  },
  {
    key: 'sales',
    label: 'Sales',
    description: 'Finds customers and prepares quotations.',
    kind: 'staff',
    locked: false,
    peopleCount: 6,
  },
  {
    key: 'operations_head',
    label: 'Operations head',
    description: 'Runs delivery and purchasing.',
    kind: 'staff',
    locked: false,
    peopleCount: 1,
  },
  {
    key: 'management',
    label: 'Management',
    description: 'Company-wide oversight.',
    kind: 'staff',
    locked: false,
    peopleCount: 2,
  },
  {
    key: 'vendor_user',
    label: 'Vendor portal user',
    description: 'External vendor contact.',
    kind: 'portal',
    locked: false,
    peopleCount: 0,
  },
  {
    key: 'customer_user',
    label: 'Customer portal user',
    description: 'External customer contact.',
    kind: 'portal',
    locked: false,
    peopleCount: 3,
  },
] as const;

export function testCatalogue(): AccessCatalogueResponse {
  const grants = [
    // Founder: everything a staff role may hold.
    grant('founder', 'crm.lead.read', 'all'),
    grant('founder', 'crm.lead.write', 'all'),
    grant('founder', 'invoice.read', 'all'),
    grant('founder', 'invoice.issue', 'all'),
    grant('founder', 'admin.users.invite', 'all'),
    grant('founder', 'portal.quotation.read', null),
    // Sales: leads widened to department (default own), no invoices.
    grant('sales', 'crm.lead.read', 'department', 'own'),
    grant('sales', 'crm.lead.write', 'own'),
    grant('sales', 'invoice.read', null),
    grant('sales', 'invoice.issue', null),
    grant('sales', 'admin.users.invite', null),
    grant('sales', 'portal.quotation.read', null),
    // Operations head: nothing here, all defaults.
    grant('operations_head', 'crm.lead.read', null),
    grant('operations_head', 'crm.lead.write', null),
    grant('operations_head', 'invoice.read', null),
    grant('operations_head', 'invoice.issue', null),
    grant('operations_head', 'admin.users.invite', null),
    grant('operations_head', 'portal.quotation.read', null),
    // Management: sees every lead and invoice.
    grant('management', 'crm.lead.read', 'all'),
    grant('management', 'crm.lead.write', null),
    grant('management', 'invoice.read', 'all'),
    grant('management', 'invoice.issue', null),
    grant('management', 'admin.users.invite', null),
    grant('management', 'portal.quotation.read', null),
    // Portal roles.
    grant('customer_user', 'crm.lead.read', null),
    grant('customer_user', 'crm.lead.write', null),
    grant('customer_user', 'invoice.read', null),
    grant('customer_user', 'invoice.issue', null),
    grant('customer_user', 'admin.users.invite', null),
    grant('customer_user', 'portal.quotation.read', 'customer_org'),
    grant('vendor_user', 'crm.lead.read', null),
    grant('vendor_user', 'crm.lead.write', null),
    grant('vendor_user', 'invoice.read', null),
    grant('vendor_user', 'invoice.issue', null),
    grant('vendor_user', 'admin.users.invite', null),
    grant('vendor_user', 'portal.quotation.read', null),
  ];

  return AccessCatalogueResponseSchema.parse({
    revision: 'rev-7',
    lastChanged: null,
    roles: ROLES,
    areas: [
      {
        key: 'leads',
        label: 'Leads',
        seePermission: 'crm.lead.read',
        actionPermissions: ['crm.lead.write'],
        hasAssignment: true,
        supportsDepartment: true,
      },
      {
        key: 'invoices',
        label: 'Invoices',
        seePermission: 'invoice.read',
        actionPermissions: ['invoice.issue'],
        hasAssignment: false,
        supportsDepartment: false,
      },
    ],
    groups: [
      { key: 'leads', label: 'Leads', permissions: ['crm.lead.read', 'crm.lead.write'] },
      { key: 'invoices', label: 'Invoices', permissions: ['invoice.read', 'invoice.issue'] },
      { key: 'administration', label: 'Administration', permissions: ['admin.users.invite'] },
      { key: 'portal', label: 'Portal access', permissions: ['portal.quotation.read'] },
    ],
    permissions: PERMISSIONS,
    grants,
    levelRules: [],
    assignment: [],
    conflicts: [],
    summaries: {},
    assignmentSummaries: {},
  });
}
