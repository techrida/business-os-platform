// Access settings API contracts (U20b): catalogue read, dry-run preview, atomic save,
// warnings (W1-W9), plain-language summaries, assignment rules, department member/head
// changes shared with the departments unit, and the Check a person report.
import { z } from 'zod';

import { AccessLevelSchema, AccessScopeSchema } from './access-model.js';
import { PermissionSchema, RoleKeySchema } from './authz.js';

export const ACCESS_ROLE_KINDS = ['founder', 'staff', 'portal'] as const;
export const AccessRoleKindSchema = z.enum(ACCESS_ROLE_KINDS);
export type AccessRoleKind = z.infer<typeof AccessRoleKindSchema>;

export const ACCESS_PERMISSION_KINDS = ['record', 'onOff', 'portal'] as const;
export const AccessPermissionKindSchema = z.enum(ACCESS_PERMISSION_KINDS);
export type AccessPermissionKind = z.infer<typeof AccessPermissionKindSchema>;

/** The nine areas shown on Access > By area in display order. */
export const ACCESS_SETTING_AREA_KEYS = [
  'leads',
  'opportunities',
  'quotations',
  'sales_orders',
  'invoices',
  'procurement',
  'payables',
  'approvals',
  'documents',
] as const;
export const AccessSettingAreaKeySchema = z.enum(ACCESS_SETTING_AREA_KEYS);
export type AccessSettingAreaKey = z.infer<typeof AccessSettingAreaKeySchema>;

/** Areas that carry editable "Who can assign" rules. */
export const ASSIGNMENT_AREA_KEYS = ['leads', 'opportunities'] as const;
export const AssignmentAreaKeySchema = z.enum(ASSIGNMENT_AREA_KEYS);
export type AssignmentAreaKey = z.infer<typeof AssignmentAreaKeySchema>;

export const STAFF_ASSIGNMENT_RULES = [
  'self_and_peers',
  'self_only',
  'any_at_or_below',
] as const;
export const StaffAssignmentRuleSchema = z.enum(STAFF_ASSIGNMENT_RULES);
export type StaffAssignmentRule = z.infer<typeof StaffAssignmentRuleSchema>;

export const MANAGER_ASSIGNMENT_RULES = ['any_at_or_below', 'self_and_staff'] as const;
export const ManagerAssignmentRuleSchema = z.enum(MANAGER_ASSIGNMENT_RULES);
export type ManagerAssignmentRule = z.infer<typeof ManagerAssignmentRuleSchema>;

export const ACCESS_WARNING_CODES = [
  'W1',
  'W2',
  'W3',
  'W4',
  'W5',
  'W6',
  'W7',
  'W8',
  'W9',
] as const;
export const AccessWarningCodeSchema = z.enum(ACCESS_WARNING_CODES);
export type AccessWarningCode = z.infer<typeof AccessWarningCodeSchema>;

export const ACCESS_WARNING_SEVERITIES = ['info', 'confirm', 'blocked'] as const;
export const AccessWarningSeveritySchema = z.enum(ACCESS_WARNING_SEVERITIES);
export type AccessWarningSeverity = z.infer<typeof AccessWarningSeveritySchema>;

export const ACCESS_ERROR_CODES = [
  'stale_access',
  'confirmation_required',
  'last_founder',
] as const;
export const AccessErrorCodeSchema = z.enum(ACCESS_ERROR_CODES);
export type AccessErrorCode = z.infer<typeof AccessErrorCodeSchema>;

// --- Read catalogue (spec 7.1) ---

export const AccessRoleInfoSchema = z.object({
  key: RoleKeySchema,
  label: z.string(),
  description: z.string(),
  kind: AccessRoleKindSchema,
  locked: z.boolean(),
  peopleCount: z.number().int().nonnegative(),
});
export type AccessRoleInfo = z.infer<typeof AccessRoleInfoSchema>;

export const AccessAreaInfoSchema = z.object({
  key: AccessSettingAreaKeySchema,
  label: z.string(),
  seePermission: PermissionSchema,
  actionPermissions: z.array(PermissionSchema),
  hasAssignment: z.boolean(),
  followsArea: AccessSettingAreaKeySchema.optional(),
  supportsDepartment: z.boolean(),
});
export type AccessAreaInfo = z.infer<typeof AccessAreaInfoSchema>;

export const AccessPermissionGroupSchema = z.object({
  key: z.string(),
  label: z.string(),
  permissions: z.array(PermissionSchema),
});
export type AccessPermissionGroup = z.infer<typeof AccessPermissionGroupSchema>;

export const AccessPermissionInfoSchema = z.object({
  key: PermissionSchema,
  label: z.string(),
  kind: AccessPermissionKindSchema,
  risk: z.string().optional(),
  separationOfDuties: z.boolean(),
  scopesFor: z.object({
    staff: z.array(AccessScopeSchema),
    portal: z.array(AccessScopeSchema),
  }),
});
export type AccessPermissionInfo = z.infer<typeof AccessPermissionInfoSchema>;

export const AccessGrantRowSchema = z.object({
  role: RoleKeySchema,
  permission: PermissionSchema,
  scope: AccessScopeSchema.nullable(),
  defaultScope: AccessScopeSchema.nullable(),
  isDefault: z.boolean(),
});
export type AccessGrantRow = z.infer<typeof AccessGrantRowSchema>;

export const AccessLevelRuleDefaultsSchema = z.object({
  managersSeeDepartment: z.boolean(),
  headsSeeDepartment: z.boolean(),
});
export type AccessLevelRuleDefaults = z.infer<typeof AccessLevelRuleDefaultsSchema>;

export const AccessLevelRuleSchema = z.object({
  area: AccessSettingAreaKeySchema,
  managersSeeDepartment: z.boolean(),
  headsSeeDepartment: z.boolean(),
  defaults: AccessLevelRuleDefaultsSchema,
});
export type AccessLevelRule = z.infer<typeof AccessLevelRuleSchema>;

export const AssignmentHandOverInputSchema = z.object({
  fromDepartmentId: z.guid(),
  toDepartmentId: z.guid(),
});
export type AssignmentHandOverInput = z.infer<typeof AssignmentHandOverInputSchema>;

export const AssignmentHandOverSchema = AssignmentHandOverInputSchema.extend({
  fromDepartmentName: z.string().optional(),
  toDepartmentName: z.string().optional(),
  fromRetired: z.boolean().optional(),
  toRetired: z.boolean().optional(),
});
export type AssignmentHandOver = z.infer<typeof AssignmentHandOverSchema>;

export const AccessAssignmentDefaultsSchema = z.object({
  staff: StaffAssignmentRuleSchema,
  managers: ManagerAssignmentRuleSchema,
  handOvers: z.array(AssignmentHandOverSchema),
});
export type AccessAssignmentDefaults = z.infer<typeof AccessAssignmentDefaultsSchema>;

export const AccessAssignmentRuleSchema = z.object({
  area: AssignmentAreaKeySchema,
  staff: StaffAssignmentRuleSchema,
  managers: ManagerAssignmentRuleSchema,
  handOvers: z.array(AssignmentHandOverSchema),
  defaults: AccessAssignmentDefaultsSchema,
});
export type AccessAssignmentRule = z.infer<typeof AccessAssignmentRuleSchema>;

export const AccessConflictRuleSchema = z.object({
  permissions: z.tuple([PermissionSchema, PermissionSchema]),
  message: z.string(),
});
export type AccessConflictRule = z.infer<typeof AccessConflictRuleSchema>;

export const AccessLastChangedSchema = z.object({
  at: z.iso.datetime(),
  byName: z.string().nullable(),
});
export type AccessLastChanged = z.infer<typeof AccessLastChangedSchema>;

export const AccessCatalogueResponseSchema = z.object({
  revision: z.string().min(1),
  lastChanged: AccessLastChangedSchema.nullable(),
  roles: z.array(AccessRoleInfoSchema),
  areas: z.array(AccessAreaInfoSchema),
  groups: z.array(AccessPermissionGroupSchema),
  permissions: z.array(AccessPermissionInfoSchema),
  grants: z.array(AccessGrantRowSchema),
  levelRules: z.array(AccessLevelRuleSchema),
  assignment: z.array(AccessAssignmentRuleSchema),
  conflicts: z.array(AccessConflictRuleSchema),
  summaries: z.record(z.string(), z.array(z.string())),
  assignmentSummaries: z.record(z.string(), z.string()),
});
export type AccessCatalogueResponse = z.infer<typeof AccessCatalogueResponseSchema>;

// --- Change union (spec 7.2 + R4) ---

export const GrantChangeSchema = z.object({
  kind: z.literal('grant'),
  role: RoleKeySchema,
  permission: PermissionSchema,
  scope: AccessScopeSchema.nullable(),
});
export type GrantChange = z.infer<typeof GrantChangeSchema>;

export const LevelRuleChangeSchema = z.object({
  kind: z.literal('levelRule'),
  area: AccessSettingAreaKeySchema,
  managersSeeDepartment: z.boolean().optional(),
  headsSeeDepartment: z.boolean().optional(),
});
export type LevelRuleChange = z.infer<typeof LevelRuleChangeSchema>;

export const AssignmentChangeSchema = z.object({
  kind: z.literal('assignment'),
  area: AssignmentAreaKeySchema,
  staff: StaffAssignmentRuleSchema.optional(),
  managers: ManagerAssignmentRuleSchema.optional(),
  handOvers: z.array(AssignmentHandOverInputSchema).max(100).optional(),
});
export type AssignmentChange = z.infer<typeof AssignmentChangeSchema>;

export const ResetRoleChangeSchema = z.object({
  kind: z.literal('resetRole'),
  role: RoleKeySchema,
});
export type ResetRoleChange = z.infer<typeof ResetRoleChangeSchema>;

export const MemberLevelChangeSchema = z.object({
  kind: z.literal('memberLevel'),
  departmentId: z.guid(),
  userId: z.guid(),
  level: AccessLevelSchema,
});
export type MemberLevelChange = z.infer<typeof MemberLevelChangeSchema>;

export const MemberAddChangeSchema = z.object({
  kind: z.literal('memberAdd'),
  departmentId: z.guid(),
  userId: z.guid(),
  level: AccessLevelSchema.optional(),
  jobTitle: z.string().trim().max(80).nullable().optional(),
});
export type MemberAddChange = z.infer<typeof MemberAddChangeSchema>;

export const MemberRemoveChangeSchema = z.object({
  kind: z.literal('memberRemove'),
  departmentId: z.guid(),
  userId: z.guid(),
});
export type MemberRemoveChange = z.infer<typeof MemberRemoveChangeSchema>;

export const MemberMoveChangeSchema = z.object({
  kind: z.literal('memberMove'),
  userId: z.guid(),
  fromDepartmentId: z.guid(),
  toDepartmentId: z.guid(),
});
export type MemberMoveChange = z.infer<typeof MemberMoveChangeSchema>;

export const MemberJobTitleChangeSchema = z.object({
  kind: z.literal('memberJobTitle'),
  departmentId: z.guid(),
  userId: z.guid(),
  jobTitle: z.string().trim().max(80).nullable(),
});
export type MemberJobTitleChange = z.infer<typeof MemberJobTitleChangeSchema>;

export const DepartmentHeadChangeSchema = z.object({
  kind: z.literal('head'),
  departmentId: z.guid(),
  userId: z.guid().nullable(),
});
export type DepartmentHeadChange = z.infer<typeof DepartmentHeadChangeSchema>;

/** Department membership and head changes, shared with the departments unit. */
export const DepartmentChangeSchema = z.discriminatedUnion('kind', [
  MemberLevelChangeSchema,
  MemberAddChangeSchema,
  MemberRemoveChangeSchema,
  MemberMoveChangeSchema,
  MemberJobTitleChangeSchema,
  DepartmentHeadChangeSchema,
]);
export type DepartmentChange = z.infer<typeof DepartmentChangeSchema>;

export const AccessPolicyChangeSchema = z.discriminatedUnion('kind', [
  GrantChangeSchema,
  LevelRuleChangeSchema,
  AssignmentChangeSchema,
  ResetRoleChangeSchema,
]);
export type AccessPolicyChange = z.infer<typeof AccessPolicyChangeSchema>;

export const AccessChangeSchema = z.discriminatedUnion('kind', [
  GrantChangeSchema,
  LevelRuleChangeSchema,
  AssignmentChangeSchema,
  ResetRoleChangeSchema,
  MemberLevelChangeSchema,
  MemberAddChangeSchema,
  MemberRemoveChangeSchema,
  MemberMoveChangeSchema,
  MemberJobTitleChangeSchema,
  DepartmentHeadChangeSchema,
]);
export type AccessChange = z.infer<typeof AccessChangeSchema>;

// --- Warnings, impact, preview and save (spec 7.2, 8.1) ---

export const AccessWarningSchema = z.object({
  code: AccessWarningCodeSchema,
  severity: AccessWarningSeveritySchema,
  message: z.string(),
  people: z.number().int().nonnegative().optional(),
  records: z.number().int().nonnegative().optional(),
  changeIndex: z.number().int().nonnegative().optional(),
});
export type AccessWarning = z.infer<typeof AccessWarningSchema>;

export const AccessAppliedChangeSchema = z.object({
  label: z.string(),
  from: z.string(),
  to: z.string(),
  serverAdded: z.boolean().optional(),
});
export type AccessAppliedChange = z.infer<typeof AccessAppliedChangeSchema>;

export const AccessImpactBucketSchema = z.object({
  people: z.number().int().nonnegative(),
  sample: z.array(z.string()).max(3),
  names: z.array(z.string()).optional(),
});
export type AccessImpactBucket = z.infer<typeof AccessImpactBucketSchema>;

export const AccessImpactSchema = z.object({
  widened: AccessImpactBucketSchema,
  narrowed: AccessImpactBucketSchema,
  unchanged: z.number().int().nonnegative(),
});
export type AccessImpact = z.infer<typeof AccessImpactSchema>;

// --- Check a person report (spec 6.2) ---

export const CheckPersonRoleSchema = z.object({
  key: RoleKeySchema,
  label: z.string(),
});
export type CheckPersonRole = z.infer<typeof CheckPersonRoleSchema>;

export const CheckPersonActionSchema = z.object({
  permission: PermissionSchema,
  label: z.string(),
  scope: AccessScopeSchema,
});
export type CheckPersonAction = z.infer<typeof CheckPersonActionSchema>;

export const CheckPersonAssignableSchema = z.object({
  userId: z.guid(),
  name: z.string(),
  departmentName: z.string().nullable(),
  level: AccessLevelSchema,
});
export type CheckPersonAssignable = z.infer<typeof CheckPersonAssignableSchema>;

export const CheckPersonAreaRowSchema = z.object({
  area: AccessSettingAreaKeySchema,
  label: z.string(),
  scope: AccessScopeSchema.nullable(),
  scopeLabel: z.string(),
  visibleCount: z.number().int().nonnegative(),
  totalCount: z.number().int().nonnegative(),
  actions: z.array(CheckPersonActionSchema),
  assignableCount: z.number().int().nonnegative().nullable(),
  assignablePeople: z.array(CheckPersonAssignableSchema).optional(),
  why: z.array(z.string()),
  previousScopeLabel: z.string().optional(),
});
export type CheckPersonAreaRow = z.infer<typeof CheckPersonAreaRowSchema>;

export const CheckPersonReportSchema = z.object({
  person: z.object({
    id: z.guid(),
    name: z.string(),
    email: z.string().nullable(),
    status: z.enum(['invited', 'active', 'inactive']),
    roles: z.array(CheckPersonRoleSchema),
    department: z.object({ id: z.guid(), name: z.string() }).nullable(),
    level: AccessLevelSchema,
  }),
  areas: z.array(CheckPersonAreaRowSchema),
});
export type CheckPersonReport = z.infer<typeof CheckPersonReportSchema>;

export const CheckPersonQuerySchema = z.strictObject({
  person: z.guid(),
});
export type CheckPersonQuery = z.infer<typeof CheckPersonQuerySchema>;

// --- Request & response bodies ---

export const AccessPreviewRequestSchema = z.object({
  changes: z.array(AccessChangeSchema).max(200),
  note: z.string().trim().max(280).optional(),
  acknowledged: z.array(AccessWarningCodeSchema).optional(),
  person: z.guid().optional(),
});
export type AccessPreviewRequest = z.infer<typeof AccessPreviewRequestSchema>;

export const AccessPreviewResponseSchema = z.object({
  applied: z.array(AccessAppliedChangeSchema),
  impact: AccessImpactSchema,
  warnings: z.array(AccessWarningSchema),
  summaries: z.record(z.string(), z.array(z.string())),
  assignmentSummaries: z.record(z.string(), z.string()),
  report: CheckPersonReportSchema.nullable().optional(),
});
export type AccessPreviewResponse = z.infer<typeof AccessPreviewResponseSchema>;

export const AccessSaveRequestSchema = z.object({
  changes: z.array(AccessChangeSchema).min(1).max(200),
  expectedRevision: z.string().min(1),
  note: z.string().trim().max(280).optional(),
  acknowledged: z.array(AccessWarningCodeSchema).default([]),
});
export type AccessSaveRequest = z.infer<typeof AccessSaveRequestSchema>;

export const AccessSaveResponseSchema = AccessCatalogueResponseSchema;
export type AccessSaveResponse = AccessCatalogueResponse;

/** Structured error payload on 409 confirmation_required. */
export const AccessConfirmationRequiredErrorSchema = z.object({
  code: z.literal('confirmation_required'),
  message: z.string(),
  warnings: z.array(AccessWarningSchema),
});
export type AccessConfirmationRequiredError = z.infer<
  typeof AccessConfirmationRequiredErrorSchema
>;

/** Structured error payload on 422 validation or blocked warning refusal. */
export const AccessValidationErrorSchema = z.object({
  code: z.literal('unprocessable'),
  message: z.string(),
  fieldErrors: z.record(z.string(), z.string()).optional(),
  warnings: z.array(AccessWarningSchema).optional(),
});
export type AccessValidationError = z.infer<typeof AccessValidationErrorSchema>;
