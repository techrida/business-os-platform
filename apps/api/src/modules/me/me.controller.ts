import { type EffectivePermission, type MeResponse, PERMISSIONS } from '@bos/contracts';
import { users } from '@bos/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { can } from '../../platform/authz/can';
import { AnyAuthenticated } from '../../platform/authz/decorators';
import { type Principal, principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import { ctx, currentPrincipal } from '../../platform/tenancy/request-context';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);

/**
 * The principal's grants as the workspace may gate on them: exactly the grants `can()` allows without a record.
 * So an inactive user gets none, a row this build does not know (a permission or scope string from
 * `role_permissions` that is not in the contracts) is dropped, and so is `assigned` on a permission no assignment
 * can hand over (a write): can() treats each of those as no grant.
 */
export function effectivePermissions(p: Principal): EffectivePermission[] {
  const out: EffectivePermission[] = [];
  for (const [permission, scope] of p.grants) {
    if (!KNOWN_PERMISSIONS.has(permission) || !can(p, permission).allowed) continue;
    out.push({ permission, scope });
  }
  return out.sort((a, b) =>
    a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0,
  );
}

// Any signed-in user may ask who they are; the tenancy interceptor refuses unmarked routes.
@AnyAuthenticated()
@Controller('v1/me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Who the caller is, straight from the request context, and what the caller may do: the effective grants of the
   * principal, which the interceptor built from the live role and level rows, with the membership's level and
   * department they were built for. The only database read of its own is one small lookup of the caller's name and
   * picture pointer on their own users row.
   */
  @Get()
  async me(): Promise<MeResponse> {
    const c = ctx();
    const p = principal();
    const own = await this.ownRow(c.tenantId);
    return {
      userId: c.userId,
      tenantId: c.tenantId,
      organizationId: c.organizationId,
      orgKind: c.orgKind,
      partyId: c.partyId,
      // Copy: the context's array is shared for the whole request, and a response body must not alias it.
      roles: [...c.roles],
      correlationId: c.correlationId,
      id: p.userId,
      avatarDocumentId: own?.avatarDocumentId ?? null,
      // A blank name is no name: the shell then falls back to the role label and a plain greeting.
      displayName: own?.displayName?.trim() || null,
      permissions: effectivePermissions(p),
      // The level and department the grants above were built for; a portal caller has neither (staff, null).
      level: p.level ?? 'staff',
      departmentId: p.departmentId,
    };
  }

  /** The caller's own row only (`app.users.id` from the principal, in the context's tenant). */
  private async ownRow(
    tenantId: string,
  ): Promise<{ avatarDocumentId: string | null; displayName: string | null } | null> {
    const appUserId = currentPrincipal()?.userId;
    if (!appUserId) return null;
    const [row] = await this.db
      .select({ avatarDocumentId: users.avatarDocumentId, displayName: users.displayName })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, appUserId)))
      .limit(1);
    return row ?? null;
  }
}
