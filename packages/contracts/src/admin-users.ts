import { z } from 'zod';

import { RoleKeySchema } from './authz.js';

export const UserStatusSchema = z.enum(['invited', 'active', 'inactive']);
export const AdminUserSortSchema = z.enum(['name', 'lastActive', 'createdAt']);
export const AdminUserSearchSchema = z.string().trim().max(200);

function positiveInteger(max: number) {
  return z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(max));
}

export const ADMIN_USERS_MAX_PAGE = 10_000;

export const AdminUsersQuerySchema = z
  .object({
    q: AdminUserSearchSchema.optional(),
    status: UserStatusSchema.optional(),
    role: RoleKeySchema.optional(),
    departmentId: z.guid().optional(),
    sort: AdminUserSortSchema.optional(),
    limit: positiveInteger(200).default(50),
    after: z.guid().optional(),
    page: positiveInteger(ADMIN_USERS_MAX_PAGE).optional(),
  })
  .refine(({ after, page, sort }) => !after || (page === undefined && sort === undefined), {
    path: ['after'],
    message: 'The id cursor is only supported with the default id order and no page number',
  });

export type AdminUsersQuery = z.infer<typeof AdminUsersQuerySchema>;

const DepartmentSchema = z.object({ id: z.guid(), name: z.string() });

export const AdminUserSchema = z.object({
  id: z.guid(),
  idpOrgId: z.guid(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  /** The user's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
  status: UserStatusSchema,
  roles: z.array(RoleKeySchema),
  department: DepartmentSchema.nullable(),
  createdAt: z.iso.datetime(),
  lastActiveAt: z.iso.datetime().nullable(),
});
export type AdminUser = z.infer<typeof AdminUserSchema>;

export const AdminUsersPageSchema = z.object({
  items: z.array(AdminUserSchema),
  nextAfter: z.guid().nullable(),
  nextPage: z.number().int().positive().nullable(),
});

export const AdminUsersSummarySchema = z.object({
  total: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  invited: z.number().int().nonnegative(),
  deactivated: z.number().int().nonnegative(),
  departments: z.array(DepartmentSchema),
  canSendPasswordReset: z.boolean(),
});
export type AdminUsersSummary = z.infer<typeof AdminUsersSummarySchema>;
