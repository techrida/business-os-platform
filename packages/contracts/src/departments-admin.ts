// Contracts for the Departments admin API (/v1/admin/departments, U20b / US-106).
// Covers department lifecycle (create, rename, retire, restore), department membership edits
// (add, move, remove, level, job title, head), unassigned staff listing, and the shared
// DepartmentChange union used by both the department save endpoint and the Access review dry-run.
import { z } from 'zod';

import { AccessLevelSchema } from './access-model.js';
import { RoleKeySchema } from './authz.js';
import { multi, searchParam } from './list-query.js';

export const DEPARTMENT_STATUSES = ['active', 'retired'] as const;
export const DepartmentStatusSchema = z.enum(DEPARTMENT_STATUSES);
export type DepartmentStatus = z.infer<typeof DepartmentStatusSchema>;

export const DEPARTMENT_NAME_MIN = 2;
export const DEPARTMENT_NAME_MAX = 60;
export const DEPARTMENT_JOB_TITLE_MAX = 80;
export const DEPARTMENT_NOTE_MAX = 280;
export const DEPARTMENT_PEOPLE_MAX_CHANGES = 100;

const DepartmentNameSchema = z
  .string()
  .trim()
  .min(DEPARTMENT_NAME_MIN, `Department name must be at least ${DEPARTMENT_NAME_MIN} characters.`)
  .max(DEPARTMENT_NAME_MAX, `Department name must be at most ${DEPARTMENT_NAME_MAX} characters.`);

const JobTitleSchema = z
  .string()
  .trim()
  .max(DEPARTMENT_JOB_TITLE_MAX)
  .transform((value) => (value.length === 0 ? null : value))
  .nullable();

// ---------------------------------------------------------------------------
// DepartmentChange union (local definition until B2 publishes access-changes.ts;
// once B2 lands, this block can be re-exported directly from access-changes.ts).
// ---------------------------------------------------------------------------
export const DepartmentChangeSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('memberLevel'),
    departmentId: z.guid(),
    userId: z.guid(),
    level: AccessLevelSchema,
  }),
  z.strictObject({
    kind: z.literal('memberAdd'),
    departmentId: z.guid(),
    userId: z.guid(),
    level: AccessLevelSchema.optional(),
    jobTitle: JobTitleSchema.optional(),
  }),
  z.strictObject({
    kind: z.literal('memberRemove'),
    departmentId: z.guid(),
    userId: z.guid(),
  }),
  z.strictObject({
    kind: z.literal('memberMove'),
    userId: z.guid(),
    fromDepartmentId: z.guid(),
    toDepartmentId: z.guid(),
  }),
  z.strictObject({
    kind: z.literal('memberJobTitle'),
    departmentId: z.guid(),
    userId: z.guid(),
    jobTitle: JobTitleSchema,
  }),
  z.strictObject({
    kind: z.literal('head'),
    departmentId: z.guid(),
    userId: z.guid().nullable(),
  }),
]);
export type DepartmentChange = z.infer<typeof DepartmentChangeSchema>;

// ---------------------------------------------------------------------------
// Query and request body schemas
// ---------------------------------------------------------------------------

/** Query params for GET /v1/admin/departments. Defaults to status=active when omitted. */
export const AdminDepartmentsQuerySchema = z.strictObject({
  q: searchParam,
  status: multi(DepartmentStatusSchema),
});
export type AdminDepartmentsQuery = z.infer<typeof AdminDepartmentsQuerySchema>;

/** Query params for GET /v1/admin/departments/unassigned. */
export const UnassignedPeopleQuerySchema = z.strictObject({
  q: searchParam,
});
export type UnassignedPeopleQuery = z.infer<typeof UnassignedPeopleQuerySchema>;

export const CreateDepartmentBodySchema = z.strictObject({
  name: DepartmentNameSchema,
  headUserId: z.guid().nullable().optional(),
});
export type CreateDepartmentBody = z.infer<typeof CreateDepartmentBodySchema>;

export const RenameDepartmentBodySchema = z.strictObject({
  name: DepartmentNameSchema,
  expectedVersion: z.number().int().min(1),
});
export type RenameDepartmentBody = z.infer<typeof RenameDepartmentBodySchema>;

export const RetireDepartmentBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
  /**
   * Required when the department still has active members: another active department id in the same
   * legal entity to move them to, or explicit `null` to leave them unassigned ("No department").
   */
  moveMembersTo: z.guid().nullable().optional(),
});
export type RetireDepartmentBody = z.infer<typeof RetireDepartmentBodySchema>;

export const RestoreDepartmentBodySchema = z.strictObject({
  expectedVersion: z.number().int().min(1),
});
export type RestoreDepartmentBody = z.infer<typeof RestoreDepartmentBodySchema>;

// ---------------------------------------------------------------------------
// Response DTO schemas
// ---------------------------------------------------------------------------

export const DepartmentHeadRefSchema = z.object({
  id: z.guid(),
  name: z.string(),
});
export type DepartmentHeadRef = z.infer<typeof DepartmentHeadRefSchema>;

export const AdminDepartmentItemSchema = z.object({
  id: z.guid(),
  name: z.string(),
  status: DepartmentStatusSchema,
  retiredAt: z.iso.datetime().nullable(),
  head: DepartmentHeadRefSchema.nullable(),
  managers: z.number().int().nonnegative(),
  members: z.number().int().nonnegative(),
  version: z.number().int().min(1),
});
export type AdminDepartmentItem = z.infer<typeof AdminDepartmentItemSchema>;

export const AdminDepartmentListSchema = z.object({
  items: z.array(AdminDepartmentItemSchema),
  unassigned: z.number().int().nonnegative(),
});
export type AdminDepartmentList = z.infer<typeof AdminDepartmentListSchema>;

export const DepartmentMemberSchema = z.object({
  userId: z.guid(),
  name: z.string(),
  email: z.string().nullable(),
  jobTitle: z.string().nullable(),
  level: AccessLevelSchema,
  roles: z.array(RoleKeySchema),
  since: z.iso.datetime().nullable(),
});
export type DepartmentMember = z.infer<typeof DepartmentMemberSchema>;

export const AdminDepartmentDetailSchema = z.object({
  id: z.guid(),
  name: z.string(),
  status: DepartmentStatusSchema,
  retiredAt: z.iso.datetime().nullable(),
  head: DepartmentHeadRefSchema.nullable(),
  managers: z.number().int().nonnegative(),
  memberCount: z.number().int().nonnegative(),
  members: z.array(DepartmentMemberSchema),
  version: z.number().int().min(1),
  revision: z.string().min(1),
});
export type AdminDepartmentDetail = z.infer<typeof AdminDepartmentDetailSchema>;

export const UnassignedPersonSchema = z.object({
  userId: z.guid(),
  name: z.string(),
  email: z.string().nullable(),
  jobTitle: z.string().nullable(),
  roles: z.array(RoleKeySchema),
});
export type UnassignedPerson = z.infer<typeof UnassignedPersonSchema>;

export const UnassignedPeopleResponseSchema = z.object({
  items: z.array(UnassignedPersonSchema),
  total: z.number().int().nonnegative(),
});
export type UnassignedPeopleResponse = z.infer<typeof UnassignedPeopleResponseSchema>;
