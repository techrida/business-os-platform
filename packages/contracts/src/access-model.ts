// The default access model (D50, D51, D52): levels on a department membership, the `assigned` scope, the areas
// the Founder will switch, the target default reach of every role on leads, and the vocabulary of the assignment
// rule. Pure data and types: no I/O, so the API, the pickers and the tests read one definition.
// The rule itself is `apps/api/src/modules/leads/lead-assignment-rule.ts`; the SQL half is migrations
// 0079 to 0083.
import { z } from 'zod';

import { type Permission, type RoleKey, SCOPES } from './authz.js';

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
 * The levels a `role_permission_levels` row may name (migration 0082). A member below every row gets the role's
 * base grant; otherwise the most senior row at or below the member's level wins.
 */
export const LEVEL_GRANT_MIN_LEVELS = ['manager', 'head'] as const satisfies readonly AccessLevel[];
export type LevelGrantMinLevel = (typeof LEVEL_GRANT_MIN_LEVELS)[number];

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
 * The areas the Founder switches (U20b) and a department head reads whole (D51). `readPermission` is the grant
 * that opens the area's list; an area with `followsArea` has none of its own and reaches whatever its parent
 * reaches (activities follow their lead or opportunity).
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
/** Staff work their own records; their managers and heads work the whole department (D50). */
const workOwnThenDepartment: Record<AccessLevel, AccessCell> = {
  staff: { create: true, read: 'own', write: 'own', assigned: true },
  manager: { create: true, read: 'department', write: 'department', assigned: true },
  head: { create: true, read: 'department', write: 'department', assigned: true },
};
/** Starts leads for Sales and sees only what they started. */
const intakeOnly: AccessCell = { create: true, read: 'created', write: 'created', assigned: false };

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
  finance: forEveryLevel(intakeOnly),
  accountant: forEveryLevel(intakeOnly),
  pmo: forEveryLevel(intakeOnly),
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
  'sales_handoff',
  'intake_handoff',
] as const;
export type AssignmentAllowReason = (typeof ASSIGNMENT_ALLOW_REASONS)[number];

export const ASSIGNMENT_DENY_REASONS = [
  /** The target outranks the caller in the same department (nobody assigns upward). */
  'upward',
  /** The target is in another department and no hand-off rule covers it. */
  'other_department',
  /** The caller or the target has no department. */
  'no_department',
  /** Sales may not assign to Marketing. */
  'reverse_handoff',
] as const;
export type AssignmentDenyReason = (typeof ASSIGNMENT_DENY_REASONS)[number];

export type AssignmentDecision =
  | { allowed: true; reason: AssignmentAllowReason }
  | { allowed: false; reason: AssignmentDenyReason };

/** A 400 message for a refused assignment, naming the field the way `assertLeadAssignee` does. */
export const ASSIGNMENT_DENY_MESSAGES: Readonly<Record<AssignmentDenyReason, string>> = {
  upward: 'cannot be someone more senior than you',
  other_department: 'is outside your department',
  no_department: 'needs you and them to belong to a department',
  reverse_handoff: 'cannot be a Marketing user: leads are handed from Marketing to Sales, not back',
};
