import {
  ForbiddenException,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import type { Request } from 'express';
import type { Observable } from 'rxjs';

import { OrgResolver } from './org-resolver';
import { bindIdentity } from './request-context';

// Fixed text: it names no org, tenant or role, so the caller learns nothing about where it landed.
const NO_ROLE = 'No project role has been granted';

/**
 * The identity AuthGuard stores on `req.auth` after verifying the token (see API-INTERFACE.md).
 * Declared here as a local type, not as a global Express augmentation, so this file cannot clash
 * with the declaration the auth unit makes.
 */
interface AuthIdentity {
  userId: string;
  zitadelOrgId: string;
  roles: readonly string[];
  tokenExp: number;
}

/**
 * Completes the request context: `req.auth` (who) plus `OrgResolver` (which tenant and org).
 *
 * Why an interceptor and not a second APP_GUARD: Nest runs all guards before any interceptor, so an
 * interceptor is guaranteed to see `req.auth` after AuthGuard whatever order modules are imported
 * in. Two APP_GUARDs would run in module registration order, which is easy to break by accident.
 * Exceptions thrown here (an unknown org gives 403) still go through the exception filter.
 *
 * Public routes have no `req.auth`, so they are skipped and `ctx()` throws there by design.
 *
 * Staff principals must hold at least one project role (CR-02). Belonging to the staff org is not
 * enough on its own: if ZITADEL self-registration is on, anyone could join that org. Customer and
 * vendor principals are scoped to their own org and keep working without a role.
 */
@Injectable()
export class TenancyInterceptor implements NestInterceptor {
  constructor(private readonly orgs: OrgResolver) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<Request & { auth?: AuthIdentity }>();
    const auth = req.auth;
    if (auth) {
      const org = await this.orgs.resolve(auth.zitadelOrgId);
      if (org.orgKind === 'staff' && auth.roles.length === 0) {
        throw new ForbiddenException(NO_ROLE);
      }
      bindIdentity({
        tenantId: org.tenantId,
        organizationId: org.organizationId,
        orgKind: org.orgKind,
        userId: auth.userId,
        roles: auth.roles,
        tokenExp: auth.tokenExp,
      });
    }
    return next.handle();
  }
}
