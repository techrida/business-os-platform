// A small Access catalogue in the API's shape (`GET /v1/admin/access`) for the Access screen tests.
// Labels mirror the API catalogue; only a few grants are set, the rest read as "no grant".
import type {
  AccessAreaInfo,
  AccessCatalogueResponse,
  AccessGrantRow,
  AccessPermissionInfo,
  AccessScope,
  Permission,
  RoleKey,
} from '@bos/contracts';

export const MARKETING_DEPT = '00000000-0000-4000-8000-0000000000a1';
export const SALES_DEPT = '00000000-0000-4000-8000-0000000000a2';

const AREAS: AccessAreaInfo[] = [
  {
    key: 'leads',
    label: 'Leads',
    seePermission: 'crm.lead.read',
    actionPermissions: ['crm.lead.write'],
    hasAssignment: true,
    supportsDepartment: true,
  },
  {
    key: 'opportunities',
    label: 'Opportunities',
    seePermission: 'crm.opportunity.read',
    actionPermissions: ['crm.opportunity.write'],
    hasAssignment: true,
    supportsDepartment: true,
  },
  {
    key: 'quotations',
    label: 'Quotations',
    seePermission: 'quotation.read',
    actionPermissions: ['quotation.draft'],
    hasAssignment: false,
    followsArea: 'opportunities',
    supportsDepartment: true,
  },
  {
    key: 'sales_orders',
    label: 'Sales orders',
    seePermission: 'sales_order.read',
    actionPermissions: ['sales_order.confirm'],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'invoices',
    label: 'Invoices',
    seePermission: 'invoice.read',
    actionPermissions: ['invoice.issue'],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'procurement',
    label: 'Procurement',
    seePermission: 'procurement.pr.read',
    actionPermissions: ['procurement.pr.create'],
    hasAssignment: false,
    supportsDepartment: true,
  },
  {
    key: 'payables',
    label: 'Payables',
    seePermission: 'payables.bill.read',
    actionPermissions: ['payables.bill.enter'],
    hasAssignment: false,
    supportsDepartment: false,
  },
  {
    key: 'approvals',
    label: 'Approvals',
    seePermission: 'approvals.requests.read',
    actionPermissions: ['approvals.requests.act'],
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

const LABELS: Partial<Record<Permission, string>> = {
  'crm.lead.read': 'See leads',
  'crm.lead.write': 'Create and edit leads',
  'crm.opportunity.read': 'See opportunities',
  'crm.opportunity.write': 'Create and edit opportunities',
  'quotation.read': 'See quotations',
  'quotation.draft': 'Draft a quotation',
  'sales_order.read': 'See sales orders',
  'sales_order.confirm': 'Confirm a sales order',
  'invoice.read': 'See invoices',
  'invoice.issue': 'Issue an invoice',
  'procurement.pr.read': 'See purchase requests',
  'procurement.pr.create': 'Raise a purchase request',
  'payables.bill.read': 'See bills',
  'payables.bill.enter': 'Enter a bill',
  'approvals.requests.read': 'See approval requests',
  'approvals.requests.act': 'Act on approval requests',
  'documents.read': 'See documents',
  'documents.upload': 'Upload documents',
};

type RoleInfo = AccessCatalogueResponse['roles'][number];
const role = (
  key: RoleKey,
  label: string,
  kind: RoleInfo['kind'],
  peopleCount: number,
): RoleInfo => ({ key, label, description: '', kind, locked: kind !== 'staff', peopleCount });

const ROLES: RoleInfo[] = [
  role('founder', 'Founder', 'founder', 1),
  role('management', 'Management', 'staff', 2),
  role('sales', 'Sales', 'staff', 6),
  role('marketing', 'Marketing', 'staff', 3),
  role('finance', 'Finance', 'staff', 1),
  role('operations_head', 'Operations Head', 'staff', 1),
  role('customer_user', 'Customer portal user', 'portal', 4),
  role('vendor_user', 'Vendor portal user', 'portal', 2),
];

/** [role, permission, saved scope, default scope] */
const GRANTS: [RoleKey, Permission, AccessScope | null, AccessScope | null][] = [
  ['management', 'crm.lead.read', 'all', 'all'],
  ['sales', 'crm.lead.read', 'own', 'own'],
  ['sales', 'crm.lead.write', 'own', 'own'],
  ['marketing', 'crm.lead.read', 'own', 'own'],
  ['finance', 'invoice.read', 'all', 'all'],
  ['sales', 'crm.opportunity.read', 'department', 'own'],
];

function permission(key: Permission): AccessPermissionInfo {
  const record = AREAS.some((area) => area.seePermission === key) || key.endsWith('.write');
  return {
    key,
    label: LABELS[key] ?? 'Unnamed permission',
    kind: record ? 'record' : 'onOff',
    separationOfDuties: false,
    scopesFor: {
      staff: key.startsWith('crm.') ? ['assigned', 'own', 'department', 'all'] : ['own', 'all'],
      portal: [],
    },
  };
}

export function accessCatalogue(): AccessCatalogueResponse {
  const keys = Object.keys(LABELS) as Permission[];
  const grants: AccessGrantRow[] = [];
  for (const info of ROLES) {
    for (const key of keys) {
      const found = GRANTS.find(([r, p]) => r === info.key && p === key);
      const scope = info.kind === 'founder' ? 'all' : (found?.[2] ?? null);
      const defaultScope = info.kind === 'founder' ? 'all' : (found?.[3] ?? null);
      grants.push({
        role: info.key,
        permission: key,
        scope,
        defaultScope,
        isDefault: scope === defaultScope,
      });
    }
  }
  const handOver = { fromDepartmentId: MARKETING_DEPT, toDepartmentId: SALES_DEPT };
  const named = { ...handOver, fromDepartmentName: 'Marketing', toDepartmentName: 'Sales' };
  return {
    revision: '7',
    lastChanged: { at: '2026-11-18T09:00:00.000Z', byName: 'Asha K.' },
    roles: ROLES,
    areas: AREAS,
    groups: [],
    permissions: keys.map(permission),
    grants,
    levelRules: AREAS.filter((area) => area.supportsDepartment).map((area) => {
      const managers = ['leads', 'opportunities', 'quotations'].includes(area.key);
      return {
        area: area.key,
        managersSeeDepartment: managers,
        headsSeeDepartment: true,
        defaults: { managersSeeDepartment: managers, headsSeeDepartment: true },
      };
    }),
    assignment: (['leads', 'opportunities'] as const).map((area) => ({
      area,
      staff: 'self_and_peers' as const,
      managers: 'any_at_or_below' as const,
      handOvers: [named],
      defaults: {
        staff: 'self_and_peers' as const,
        managers: 'any_at_or_below' as const,
        handOvers: [named],
      },
    })),
    conflicts: [],
    summaries: Object.fromEntries(
      AREAS.map((area) => [
        area.key,
        area.key === 'leads'
          ? ['Sales and Marketing see their own leads.', 'Management sees every lead.']
          : [`Only Founders can see ${area.label.toLowerCase()}.`],
      ]),
    ),
    assignmentSummaries: {
      leads: 'Staff can assign to themselves and same-level colleagues in their department.',
      opportunities: 'Staff can assign to themselves and same-level colleagues.',
      quotations: 'Quotations follow their opportunity.',
    },
  };
}
