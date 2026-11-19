import {
  type EffectivePermission,
  type MeResponse,
  PERMISSIONS,
  type Permission,
  SCOPES,
  type Scope,
} from '@bos/contracts';
import { Controller, Get } from '@nestjs/common';

import { AnyAuthenticated } from '../../platform/authz/decorators';
import { type Principal, principal } from '../../platform/authz/principal';
import { ctx } from '../../platform/tenancy/request-context';

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
    out.push({ permission: permission as Permission, scope: scope as Scope });
  }
  return out.sort((a, b) => (a.permission < b.permission ? -1 : a.permission > b.permission ? 1 : 0));
}

// Any signed-in user may ask who they are; the tenancy interceptor refuses unmarked routes.
@AnyAuthenticated()
@Controller('v1/me')
export class MeController {
  /**
   * Who the caller is, straight from the request context (no database read of its own), and what the caller may
   * do: the effective grants of the principal, which the interceptor built from the live role rows.
   */
  @Get()
  me(): MeResponse {
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
      permissions: effectivePermissions(principal()),
    };
  }
}
