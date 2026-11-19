// The default access model (D50, D51, D52): levels on a department membership, the `assigned` scope, the areas
// the Founder will switch, the target default reach of every role on leads, and the vocabulary of the assignment
// rule. Pure data and types: no I/O, so the API, the pickers and the tests read one definition.
// The rule itself is `apps/api/src/modules/leads/lead-assignment-rule.ts`; the SQL half is migrations
// 0079 to 0083 and 0088.
import { z } from 'zod';

import {
  DEFAULT_ROLE_PERMISSIONS,
  type Permission,
  ROLE_KEYS,
  type RoleKey,
  SCOPES,
} from './authz.js';

/** A department membership's rank. A head leads the department, a manager leads staff, staff do the work. */
export const ACCESS_LEVELS = ['staff', 'manager', 'head'] as const;
export const AccessLevelSchema = z.enum(ACCESS_LEVELS);
export type AccessLevel = z.infer<typeof AccessLevelSchema>;

/** Higher is more senior. Compare levels with this, never by position in a string comparison. */
export const ACCESS_LEVEL_RANK: Readonly<Record<AccessLevel, number>> = {
  staff: 0,
  manager: 1,
  head: 2,
};

/** `a` is at least as senior as `b`. */
export function levelAtLeast(a: AccessLevel, b: AccessLevel): boolean {
  return ACCESS_LEVEL_RANK[a] >= ACCESS_LEVEL_RANK[b];
}

/**
 * Every scope a `role_permissions` row may hold in the database: the four `Scope`s plus `assigned`, read-only
 * access to a record the caller holds an open or past activity assignment on (migration 0082). `Scope` itself
 * is unchanged until the access services honour `assigned`; an unknown scope grants nothing in `can()`.
 */
export const ACCESS_SCOPES = [...SCOPES, 'assigned'] as const;
export const AccessScopeSchema = z.enum(ACCESS_SCOPES);
export type AccessScope = z.infer<typeof AccessScopeSchema>;

/**
 * Higher reaches further. Two grants of one permission merge to the wider. `assigned` is the narrowest because own
 * read also covers what the caller is assigned (D55-5), and `customer_org` sits below `all` as it does in the
 * role cache.
 */
export const ACCESS_SCOPE_RANK: Readonly<Record<AccessScope, number>> = {
  assigned: 0,
  own: 1,
  department: 2,
  customer_org: 3,
  all: 4,
};

/**
 * The read permissions whose `own` scope also reaches, read only, the records the caller holds a non-cancelled
 * activity assignment on, and for leads the records the caller created (D50, D55-3, D55-5). Writes stay with the
 * owner.
 */
export const RECORD_REACH_READ_PERMISSIONS = [
  'crm.lead.read',
  'crm.opportunity.read',
  'quotation.read',
] as const satisfies readonly Permission[];

/**
 * The levels a `role_permission_levels` row may name (migration 0082). A member below every row gets the role's
 * base grant. Otherwise they get the wider of the base grant and the most senior row at or below their level: a
 * level row only ever widens what the role gives, never narrows it.
 */
export const LEVEL_GRANT_MIN_LEVELS = ['manager', 'head'] as const satisfies readonly AccessLevel[];
export type LevelGrantMinLevel = (typeof LEVEL_GRANT_MIN_LEVELS)[number];

/** One `role_permission_levels` row of a role: from `minLevel` up, the role reaches `scope` on `permission`. */
export interface LevelGrant {
  permission: Permission;
  minLevel: LevelGrantMinLevel;
  scope: AccessScope;
}

/** The Marketing role (D50) and the Sales role, by key: the assignment rule never looks at a department's name. */
export const MARKETING_ROLE_KEY = 'marketing' as const satisfies RoleKey;
export const SALES_ROLE_KEY = 'sales' as const satisfies RoleKey;

/**
 * Roles that may start a lead without working leads themselves (US-114, D50). The owner they pick is a Sales
 * user, and what they created stays readable to them.
 */
export const LEAD_INTAKE_ROLE_KEYS = [
  'finance',
  'accountant',
  'pmo',
] as const satisfies readonly RoleKey[];

/**
 * The record areas and the grant that opens each one's list. `readPermission` is the area's see permission; an
 * area with `followsArea` has none of its own and reaches whatever its parent reaches (activities follow their
 * lead or opportunity). Which areas a manager or head reaches whole is `LEVEL_RULE_AREAS`.
 */
export const ACCESS_AREAS = [
  { key: 'leads', label: 'Leads', readPermission: 'crm.lead.read' },
  { key: 'opportunities', label: 'Opportunities', readPermission: 'crm.opportunity.read' },
  { key: 'activities', label: 'Activities', followsArea: 'leads' },
  { key: 'quotations', label: 'Quotations', readPermission: 'quotation.read' },
  { key: 'sales_orders', label: 'Sales orders', readPermission: 'sales_order.read' },
  { key: 'invoices', label: 'Invoices', readPermission: 'invoice.read' },
  { key: 'procurement', label: 'Procurement', readPermission: 'procurement.pr.read' },
  { key: 'payables', label: 'Payables', readPermission: 'payables.bill.read' },
  { key: 'approvals', label: 'Approvals', readPermission: 'approvals.requests.read' },
  { key: 'documents', label: 'Documents', readPermission: 'documents.read' },
] as const satisfies readonly AccessArea[];

export interface AccessArea {
  key: string;
  label: string;
  readPermission?: Permission;
  followsArea?: string;
}

export type AccessAreaKey = (typeof ACCESS_AREAS)[number]['key'];

// --- Default level grants (D50, D51). Migration 0088 writes exactly these rows. ---

/**
 * One area's department-reach switches, as Settings > Access (U20b) models them: a manager or head reaches the
 * department on the area's `seePermission`, and only where the area's records carry a department
 * (`supportsDepartment`). The switches are the defaults a tenant starts with.
 *
 * `editPermission` pairs a write with the see permission under the same switch, for the areas where a manager or
 * head must change the department's records and not only see them: a Sales manager reassigns a staff member's lead
 * and reschedules its follow-ups, and both need write reach (D50). Every other write stays with the owner.
 */
export interface LevelRuleArea {
  key: string;
  seePermission: Permission;
  editPermission?: Permission;
  supportsDepartment: boolean;
  managersSeeDepartment: boolean;
  headsSeeDepartment: boolean;
}

/**
 * The nine areas of Settings > Access with their default level switches (D50, D51). Contracts cannot import the
 * API catalogue, so this is the one copy the defaults derive from; the API's ACCESS_AREA_CATALOGUE and
 * DEFAULT_LEVEL_RULES must agree with it. Sales orders, invoices, payables, approvals and documents carry no
 * department, so no level row reaches them.
 */
export const LEVEL_RULE_AREAS = [
  {
    key: 'leads',
    seePermission: 'crm.lead.read',
    editPermission: 'crm.lead.write',
    supportsDepartment: true,
    managersSeeDepartment: true,
    headsSeeDepartment: true,
  },
  {
    key: 'opportunities',
    seePermission: 'crm.opportunity.read',
    editPermission: 'crm.opportunity.write',
    supportsDepartment: true,
    managersSeeDepartment: true,
    headsSeeDepartment: true,
  },
  {
    key: 'quotations',
    seePermission: 'quotation.read',
    supportsDepartment: true,
    managersSeeDepartment: true,
    headsSeeDepartment: true,
  },
  {
    key: 'sales_orders',
    seePermission: 'sales_order.read',
    supportsDepartment: false,
    managersSeeDepartment: false,
    headsSeeDepartment: false,
  },
  {
    key: 'invoices',
    seePermission: 'invoice.read',
    supportsDepartment: false,
    managersSeeDepartment: false,
    headsSeeDepartment: false,
  },
  {
    key: 'procurement',
    seePermission: 'procurement.pr.read',
    supportsDepartment: true,
    managersSeeDepartment: false,
    headsSeeDepartment: true,
  },
  {
    key: 'payables',
    seePermission: 'payables.bill.read',
    supportsDepartment: false,
    managersSeeDepartment: false,
    headsSeeDepartment: false,
  },
  {
    key: 'approvals',
    seePermission: 'approvals.requests.read',
    supportsDepartment: false,
    managersSeeDepartment: false,
    headsSeeDepartment: false,
  },
  {
    key: 'documents',
    seePermission: 'documents.read',
    supportsDepartment: false,
    managersSeeDepartment: false,
    headsSeeDepartment: false,
  },
] as const satisfies readonly LevelRuleArea[];

/** Portal users hold no department membership, so no level grant applies to them. */
const PORTAL_ROLE_KEYS: readonly RoleKey[] = ['customer_user', 'vendor_user'];

/** The roles a level row may name: every role but the Founder (who reaches everything) and the portal roles. */
const LEVEL_STAFF_ROLE_KEYS: readonly RoleKey[] = ROLE_KEYS.filter(
  (role) => role !== 'founder' && !PORTAL_ROLE_KEYS.includes(role),
);

/**
 * A base grant a department row would widen. The access settings rank `customer_org` below `department`, so it
 * counts too; no grant at all does not, because a level row never creates access.
 */
function widenableByDepartment(scope: AccessScope | undefined): boolean {
  return scope !== undefined && scope !== 'department' && scope !== 'all';
}

/**
 * The intake roles hold crm.lead.write only so they can start a lead for a Sales owner; they never edit leads, so
 * no switch widens that write for their managers or heads.
 */
function editsArea(role: RoleKey): boolean {
  return !(LEAD_INTAKE_ROLE_KEYS as readonly RoleKey[]).includes(role);
}

/**
 * One role's default level rows, derived the way Settings > Access materialises them so the two cannot drift: for
 * every area with department reach, a manager row when the area's managers see the department and a head row when
 * its heads do, on the area's see permission and, for a role that edits the area, its edit permission. Each
 * permission gets rows only where the role's base grant on it exists and is narrower than the department, the same
 * test migration 0088 applies per tenant row.
 */
function defaultLevelGrants(role: RoleKey): LevelGrant[] {
  if (!LEVEL_STAFF_ROLE_KEYS.includes(role)) return [];
  const base: Partial<Record<Permission, AccessScope>> = DEFAULT_ROLE_PERMISSIONS[role];
  const areas: readonly LevelRuleArea[] = LEVEL_RULE_AREAS;
  const rows: LevelGrant[] = [];
  for (const area of areas) {
    if (!area.supportsDepartment) continue;
    const permissions = [area.seePermission];
    if (area.editPermission !== undefined && editsArea(role)) permissions.push(area.editPermission);
    for (const permission of permissions) {
      if (!widenableByDepartment(base[permission])) continue;
      if (area.managersSeeDepartment) {
        rows.push({ permission, minLevel: 'manager', scope: 'department' });
      }
      if (area.headsSeeDepartment) {
        rows.push({ permission, minLevel: 'head', scope: 'department' });
      }
    }
  }
  return rows;
}

/**
 * What each role gives a manager or head on top of its base grant (`DEFAULT_ROLE_PERMISSIONS`). Like that
 * constant, the table (`app.role_permission_levels`) is the live truth once a tenant has rows.
 */
export const DEFAULT_ROLE_PERMISSION_LEVELS: Readonly<Record<RoleKey, readonly LevelGrant[]>> =
  Object.fromEntries(ROLE_KEYS.map((role) => [role, defaultLevelGrants(role)])) as unknown as Record<
    RoleKey,
    readonly LevelGrant[]
  >;

// --- Target default reach on leads (D50). The seed and the services adopt it in phase 2. ---

/**
 * How much of an area a role reaches. `created` is the records the caller entered (leads.created_by_user_id),
 * which is what Finance, Accountant and PMO keep after the owner becomes a Sales user.
 */
export const ACCESS_REACHES = ['none', 'created', 'own', 'department', 'all'] as const;
export type AccessReach = (typeof ACCESS_REACHES)[number];

export const ACCESS_REACH_RANK: Readonly<Record<AccessReach, number>> = {
  none: 0,
  created: 1,
  own: 2,
  department: 3,
  all: 4,
};

export interface AccessCell {
  /** May start a record. */
  create: boolean;
  read: AccessReach;
  write: AccessReach;
  /** Also reads, read only, the records the caller holds an activity assignment on. */
  assigned: boolean;
}

const NO_ACCESS: AccessCell = { create: false, read: 'none', write: 'none', assigned: false };
const forEveryLevel = (cell: AccessCell): Record<AccessLevel, AccessCell> => ({
  staff: cell,
  manager: cell,
  head: cell,
});
/**
 * Staff work their own records; their managers and heads see and edit the whole department (D50), so they can hand
 * a staff member's lead to someone else and reschedule its follow-ups. The edit rows come from the same switch as
 * the see rows (`editPermission` in LEVEL_RULE_AREAS).
 */
const workOwnThenDepartment: Record<AccessLevel, AccessCell> = {
  staff: { create: true, read: 'own', write: 'own', assigned: true },
  manager: { create: true, read: 'department', write: 'department', assigned: true },
  head: { create: true, read: 'department', write: 'department', assigned: true },
};
/**
 * Starts leads for Sales and reads, but does not edit, what they started. Their own read is narrower than the
 * department, so the default lead and opportunity switches widen it for their managers and heads as for anyone.
 */
const intakeOnly: Record<AccessLevel, AccessCell> = {
  staff: { create: true, read: 'created', write: 'none', assigned: false },
  manager: { create: true, read: 'department', write: 'none', assigned: false },
  head: { create: true, read: 'department', write: 'none', assigned: false },
};

/**
 * What each role reaches on leads by default, per membership level. Opportunities and quotations follow their
 * lead or opportunity and activities follow their parent record, so this table is the one source for the CRM
 * areas. Roles that never hold a level (portal users) use the same cell for every level.
 */
export const TARGET_LEAD_ACCESS: Readonly<Record<RoleKey, Record<AccessLevel, AccessCell>>> = {
  founder: forEveryLevel({ create: true, read: 'all', write: 'all', assigned: false }),
  management: forEveryLevel({ create: false, read: 'all', write: 'none', assigned: false }),
  sales: workOwnThenDepartment,
  marketing: workOwnThenDepartment,
  finance: intakeOnly,
  accountant: intakeOnly,
  pmo: intakeOnly,
  operations_head: forEveryLevel(NO_ACCESS),
  procurement: forEveryLevel(NO_ACCESS),
  warehouse: forEveryLevel(NO_ACCESS),
  operations_officer: forEveryLevel(NO_ACCESS),
  customer_user: forEveryLevel(NO_ACCESS),
  vendor_user: forEveryLevel(NO_ACCESS),
};

// --- The assignment rule's vocabulary ---

/** Who is being handed what: the member's roles and the department and level of their membership in the entity. */
export interface AssignmentParty {
  userId: string;
  roleKeys: readonly RoleKey[];
  /** NULL when the membership has no department. */
  departmentId: string | null;
  /** The membership's level; a user with no department is `staff`. */
  level: AccessLevel;
}

/** `create`: choosing the owner of a new record. `reassign`: changing the owner or assignee of an existing one. */
export type AssignmentContext = 'create' | 'reassign';

export const ASSIGNMENT_ALLOW_REASONS = [
  'founder',
  'self',
  'department',
  /** A hand-over of the policy covers the pair (by default Marketing to Sales). */
  'handover',
  'intake_handoff',
  /** Old name of `handover`; kept until the rule moves to the new codes, then removed. */
  'sales_handoff',
] as const;
export type AssignmentAllowReason = (typeof ASSIGNMENT_ALLOW_REASONS)[number];

export const ASSIGNMENT_DENY_REASONS = [
  /** The target outranks the caller in the same department (nobody assigns upward). */
  'upward',
  /** The target is in another department and no hand-over covers it. */
  'other_department',
  /** The caller or the target has no department. */
  'no_department',
  /** The target holds a role the caller's role does not hand over to (by default Sales to Marketing). */
  'no_handover',
  /** Finance, Accountant and PMO start a lead for a Sales user, not for themselves or a colleague. */
  'sales_owner_required',
  /** The policy lets staff assign only to themselves. */
  'self_only',
  /** The policy lets managers and heads assign only to themselves and people below their level, not a peer. */
  'same_level',
  /** The target could not read the record the work is about, so it cannot be given to them (dead-end #21). */
  'cannot_read_subject',
  /** The target is not an active staff member of the acting entity (a portal user, disabled, or elsewhere). */
  'not_active_staff',
  /** Old name of `no_handover`; kept until the rule moves to the new codes, then removed. */
  'reverse_handoff',
] as const;
export type AssignmentDenyReason = (typeof ASSIGNMENT_DENY_REASONS)[number];

export type AssignmentDecision =
  | { allowed: true; reason: AssignmentAllowReason }
  | { allowed: false; reason: AssignmentDenyReason };

/**
 * A 400 message for a refused assignment, after the field name the way `assertLeadAssignee` writes it ("Owner
 * cannot be ..."). The API also sends the code itself as `details.assignmentReason`.
 */
export const ASSIGNMENT_DENY_MESSAGES: Readonly<Record<AssignmentDenyReason, string>> = {
  upward: 'cannot be someone more senior than you',
  other_department: 'is outside your department',
  no_department: 'needs you and them to belong to a department',
  no_handover: 'is in a team you do not hand work over to',
  sales_owner_required: 'must be a Sales user',
  self_only: 'can only be you',
  same_level: 'must be you or someone below your level',
  cannot_read_subject: 'cannot see the record this is about',
  not_active_staff: 'is not an active staff member of this entity',
  reverse_handoff: 'cannot be a Marketing user: leads are handed from Marketing to Sales, not back',
};

/** Why an assignment is allowed, in product words: the "Why" column of Check a person (spec 6.2). */
export const ASSIGNMENT_ALLOW_LABELS: Readonly<Record<AssignmentAllowReason, string>> = {
  founder: 'Founder',
  self: 'Themselves',
  department: 'Same department, at or below their level',
  handover: 'Hand-over to another department',
  intake_handoff: 'New lead for Sales',
  sales_handoff: 'Hand-over to another department',
};
