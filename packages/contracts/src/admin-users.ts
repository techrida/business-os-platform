import { z } from 'zod';

import { RoleKeySchema } from './authz.js';
import { multi, searchParam } from './list-query.js';

export const UserStatusSchema = z.enum(['invited', 'active', 'inactive']);
/**
 * Why a person is locked (F1-Q4, F1-Q5). `failed_sign_ins`: too many wrong passwords or codes; the lock ends by itself
 * after ACCOUNT_LOCKOUT.lockMinutes, or earlier when an admin unlocks. `admin`: an admin locked them; only an admin
 * unlocks. A locked person's status is `inactive`.
 */
export const UserLockReasonSchema = z.enum(['failed_sign_ins', 'admin']);
export type UserLockReason = z.infer<typeof UserLockReasonSchema>;

/**
 * The sign-in lockout (F1-Q4), the same for every deployment: after this many wrong passwords or one-time codes in a
 * row the identity service locks the person, and the app unlocks them `lockMinutes` after it saw the lock.
 */
export const ACCOUNT_LOCKOUT = {
  maxPasswordAttempts: 5,
  maxOtpAttempts: 5,
  lockMinutes: 15,
} as const;
export const AdminUserSortSchema = z.enum(['name', 'lastActive', 'createdAt']);
export const AdminUserSearchSchema = z.string().trim().max(200);

function positiveInteger(max: number) {
  return z
    .union([z.number(), z.string().regex(/^\d+$/).transform(Number)])
    .pipe(z.number().int().min(1).max(max));
}

export const ADMIN_USERS_MAX_PAGE = 10_000;

// status and role repeat (`?status=active&status=invited`); a role filter matches users holding any of them.
export const AdminUsersQuerySchema = z
  .strictObject({
    q: searchParam,
    status: multi(UserStatusSchema),
    role: multi(RoleKeySchema),
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
  /** Why the person is locked; null or absent = not locked (F1-Q4). */
  lockReason: UserLockReasonSchema.nullable().optional(),
  /** When a `failed_sign_ins` lock ends by itself; null for an admin lock or no lock. */
  lockedUntil: z.iso.datetime().nullable().optional(),
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
  /** People flagged for identity review; the Users page badge reads it without listing them. Absent from an older API. */
  flagged: z.number().int().nonnegative().optional(),
  departments: z.array(DepartmentSchema),
  canSendPasswordReset: z.boolean(),
  /** Whether the caller may deactivate, reactivate, lock and unlock people (F1-Q5); absent from an older API. */
  canChangeStatus: z.boolean().optional(),
});
export type AdminUsersSummary = z.infer<typeof AdminUsersSummarySchema>;

/** A person a failed or unsure write to the identity provider left flagged for review (FU8). */
export const FlaggedUserSchema = z.object({
  id: z.guid(),
  email: z.string().nullable(),
  displayName: z.string().nullable(),
  status: UserStatusSchema,
  /** When BOS set the flag; null only for a row flagged before the time was kept. */
  flaggedAt: z.iso.datetime().nullable(),
  /** The audit reason of the flag, such as `users.deactivate:timeout`; null when its audit row was never written. */
  reason: z.string().nullable(),
});
export type FlaggedUser = z.infer<typeof FlaggedUserSchema>;

export const FlaggedUsersSchema = z.object({ items: z.array(FlaggedUserSchema) });
