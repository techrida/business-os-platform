import { z } from 'zod';

import { AccessLevelSchema, AccessScopeSchema } from './access-model.js';
import { PermissionSchema } from './authz.js';

/** Same shape the API accepts for `x-request-id` (see the API correlation middleware). */
export const CorrelationIdSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/);

export const OrgKindSchema = z.enum(['staff', 'customer', 'vendor']);
export type OrgKind = z.infer<typeof OrgKindSchema>;

/**
 * One effective grant of the caller in the acting entity: a permission and the widest scope the caller's roles
 * give it at the caller's level, read from the live `role_permissions` and `role_permission_levels` rows (not the
 * defaults). The scope says how far it reaches (only work given to them, own records, the department, the
 * caller's party, or the whole entity). It answers page-level questions such as "may this person create a
 * customer"; a decision on one record comes from that record's own `can` flags.
 */
export const EffectivePermissionSchema = z.object({
  permission: PermissionSchema,
  scope: AccessScopeSchema,
});
export type EffectivePermission = z.infer<typeof EffectivePermissionSchema>;

/** Response body of `GET /v1/me`. */
export const MeResponseSchema = z.object({
  /** ZITADEL `sub`. */
  userId: z.string().min(1),
  tenantId: z.guid(),
  organizationId: z.guid(),
  orgKind: OrgKindSchema,
  /** The customer or vendor party of a portal caller (ADR 0027); null for staff. */
  partyId: z.guid().nullable(),
  roles: z.array(z.string()),
  correlationId: CorrelationIdSchema,
  /** The caller's own `app.users.id` (not the identity provider's `userId`); the owner id of their profile picture. Absent when unknown. */
  id: z.guid().nullable().optional(),
  /** The caller's picture (`app.users.avatar_document_id`); null or absent shows initials. */
  avatarDocumentId: z.guid().nullable().optional(),
  /**
   * The caller's name as the identity service holds it (`app.users.display_name`), for the shell's user card and
   * greeting; null when it is not known yet. Optional only so a client reading an older API keeps working.
   */
  displayName: z.string().nullable().optional(),
  /**
   * The caller's effective grants, sorted by permission; empty when the user may not act (not active). The API
   * always sends it; it is optional only so a client reading an older API treats a missing list as no grants.
   */
  permissions: z.array(EffectivePermissionSchema).optional(),
  /**
   * The level of the caller's membership in the acting entity (staff without a department). Optional only so a
   * client reading an older API keeps working.
   */
  level: AccessLevelSchema.optional(),
  /** The department of that membership; null when the caller belongs to none. */
  departmentId: z.guid().nullable().optional(),
});
export type MeResponse = z.infer<typeof MeResponseSchema>;

/**
 * A `/v1/me` body with the grant rows this build does not know taken out, and what was dropped (FU6). A newer API
 * may report a permission or a scope an older client has no name for (K1 added `vat.sales.read`); the strict
 * schema would refuse the whole body and break sign-in, which would force the workspace to deploy before the API.
 * Only rows of `permissions` that are not a known permission with a known scope are removed: a known row stays
 * strictly typed, and every other field is left for the schema to judge. Anything that is not an object with a
 * `permissions` array is returned as it came.
 */
export function dropUnknownGrants(body: unknown): { body: unknown; dropped: string[] } {
  if (typeof body !== 'object' || body === null || !('permissions' in body)) {
    return { body, dropped: [] };
  }
  const { permissions } = body;
  if (!Array.isArray(permissions)) return { body, dropped: [] };
  const dropped: string[] = [];
  const kept = permissions.filter((row: unknown) => {
    if (EffectivePermissionSchema.safeParse(row).success) return true;
    // Only strings go into the label: String() of a hostile value (an object with a null toString) throws.
    const field = (key: 'permission' | 'scope'): string => {
      const value =
        typeof row === 'object' && row !== null ? (row as Record<string, unknown>)[key] : undefined;
      return typeof value === 'string' ? value : '?';
    };
    const label =
      typeof row === 'object' && row !== null
        ? `${field('permission')}@${field('scope')}`
        : 'malformed';
    dropped.push(label);
    return false;
  });
  return dropped.length === 0
    ? { body, dropped }
    : { body: { ...body, permissions: kept }, dropped };
}
