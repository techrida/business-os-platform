import {
  type EffectivePermission,
  type MeResponse,
  PERMISSIONS,
  SCOPES,
} from '@bos/contracts';
import { users } from '@bos/db';
import { Controller, Get, Inject } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { type Principal, principal } from '../../platform/authz/principal';
import { DB, type Db } from '../../platform/db/db.module';
import { ctx, currentPrincipal } from '../../platform/tenancy/request-context';

const KNOWN_PERMISSIONS: ReadonlySet<string> = new Set(PERMISSIONS);
const KNOWN_SCOPES: ReadonlySet<string> = new Set(SCOPES);

/**
 * The principal's grants as the workspace may gate on them: the same answer `can()` gives without a record.
 * An inactive user gets none (can() refuses every action), and a row this build does not know (a permission or
 * scope string from `role_permissions` that is not in the contracts) is dropped, as can() treats it as no grant.
 */
export function effectivePermissions(p: Principal): EffectivePermission[] {
  if (p.status !== 'active') return [];
  const out: EffectivePermission[] = [];
  for (const [permission, scope] of p.grants) {
    if (!KNOWN_PERMISSIONS.has(permission) || !KNOWN_SCOPES.has(scope)) continue;
    out.push({ permission, scope });
  }
  return out.sort((a, b) => (a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0));
}

// Any signed-in user may ask who they are; the tenancy interceptor refuses unmarked routes.
@AnyAuthenticated()
@Controller('v1/me')
export class MeController {
  constructor(@Inject(DB) private readonly db: Db) {}

  /**
   * Who the caller is, straight from the request context, and what the caller may do: the effective grants of the
   * principal, which the interceptor built from the live role rows. The only database read of its own is one small
   * lookup of the caller's picture pointer on their own users row.
   */
  @Get()
  async me(): Promise<MeResponse> {
    const c = ctx();
    return {
      userId: c.userId,
      tenantId: c.tenantId,
      organizationId: c.organizationId,
      orgKind: c.orgKind,
      partyId: c.partyId,
      // Copy: the context's array is shared for the whole request, and a response body must not alias it.
      roles: [...c.roles],
      correlationId: c.correlationId,
      id: currentPrincipal()?.userId ?? null,
      avatarDocumentId: await this.avatarOf(c.tenantId),
      permissions: effectivePermissions(principal()),
    };
  }

  /** The caller's own row only (`app.users.id` from the principal, in the context's tenant). */
  private async avatarOf(tenantId: string): Promise<string | null> {
    const appUserId = currentPrincipal()?.userId;
    if (!appUserId) return null;
    const [row] = await this.db
      .select({ avatarDocumentId: users.avatarDocumentId })
      .from(users)
      .where(and(eq(users.tenantId, tenantId), eq(users.id, appUserId)))
      .limit(1);
    return row?.avatarDocumentId ?? null;
  }
}
