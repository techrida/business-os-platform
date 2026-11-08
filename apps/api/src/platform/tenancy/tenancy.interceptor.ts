// The one enforcement point for every authenticated route: it completes the request context, builds
// the caller's `Principal` and applies the route's `@Can` / `@AnyAuthenticated` marker. Serves the
// NFRs "authorization is deny-by-default" and "< 5 ms per decision" (P1 plan §1, k-authz; §6.2;
// findings 3 and 4): a route with no marker is refused, and a warm request touches no database.
import { type OrgKind, type Permission, ROLE_KEYS, type RoleKey } from '@bos/contracts';
import {
  ForbiddenException,
  Inject,
  Injectable,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Observable } from 'rxjs';

import type { AuthIdentity, AuthenticatedRequest } from '../auth/claims';
import { can } from '../authz/can';
import { ANY_AUTHENTICATED_KEY, CAN_KEY } from '../authz/decorators';
import type { DenyReason, Principal } from '../authz/principal';
import { RoleCache } from '../authz/role-cache';
import { UserDirectory } from '../authz/user-directory';
import { CLOCK, type Clock, OrgResolver } from './org-resolver';
import { bindIdentity, bindPrincipal } from './request-context';

// Fixed text: it names no org, tenant or role, so the caller learns nothing about where it landed.
const NO_ROLE = 'No project role has been granted';

/**
 * How long a `UserDirectory.resolve()` answer is reused. A deactivated user can act for at most
 * this long on one api instance; the role list itself comes from the token, so it is never stale.
 */
export const USER_CACHE_TTL_MS = 60_000;

/** Upper bound on cached users per instance, so a flood of distinct tokens cannot grow memory. */
export const USER_CACHE_MAX = 10_000;

type ResolvedUser = Awaited<ReturnType<UserDirectory['resolve']>>;

interface UserCacheEntry {
  user: ResolvedUser;
  expiresAt: number;
}

const KNOWN_ROLES: ReadonlySet<string> = new Set(ROLE_KEYS);

/**
 * Which kind of org each role belongs to. A role counts only in an org of its own kind: a ZITADEL
 * admin who grants `founder` inside a customer org must not turn a customer into staff. The route
 * sweep (test/e2e/route-sweep.e2e.test.ts) found that without this, such a token passed every
 * `@Can` route, because RoleCache falls back to the staff defaults for an org with no rows.
 */
const ROLE_ORG_KIND: Readonly<Record<RoleKey, OrgKind>> = {
  founder: 'staff',
  management: 'staff',
  finance: 'staff',
  accountant: 'staff',
  sales: 'staff',
  customer_user: 'customer',
  vendor_user: 'vendor',
};

/**
 * The roles the token grants in the caller's own org, and nothing else (finding 4). There is
 * deliberately no fallback to `auth.roles`, the union across every org: a token without
 * `rolesByOrg` simply has no roles here. Roles of another org kind are dropped too (ROLE_ORG_KIND).
 */
function rolesInOrg(auth: AuthIdentity, orgKind: OrgKind): readonly RoleKey[] {
  const listed: unknown = auth.rolesByOrg?.[auth.zitadelOrgId];
  // `Array.isArray` guards against a plain-object lookup such as `['constructor']`.
  if (!Array.isArray(listed)) return Object.freeze([]);
  const roles = listed.filter(
    (role: unknown): role is RoleKey =>
      typeof role === 'string' &&
      KNOWN_ROLES.has(role) &&
      ROLE_ORG_KIND[role as RoleKey] === orgKind,
  );
  return Object.freeze([...new Set(roles)]);
}

/** Same body shape `AuthzService.assert()` throws, so every 403 reads alike to the workspace. */
const forbidden = (reason: DenyReason): ForbiddenException =>
  new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason });

/**
 * Completes the request context and enforces the route-level permission, in this order:
 * resolve org → bindIdentity → UserDirectory.resolve (cached 60 s) → roles of this org only →
 * grants from RoleCache → bindPrincipal → `@Can` / `@AnyAuthenticated` / deny.
 *
 * Why an interceptor and not a second APP_GUARD (finding 3): Nest runs all guards before any
 * interceptor, so this always sees `req.auth` after AuthGuard whatever order modules are imported
 * in, while two APP_GUARDs would run in registration order, which is easy to break. Interceptors
 * also run before pipes, so a caller without the permission gets 403 before body validation and
 * before a handler could answer 404 (which would leak whether a record exists).
 *
 * Public routes have no `req.auth`, so they pass through untouched and `ctx()` throws there by design.
 *
 * Staff principals must hold at least one project role (CR-02). Belonging to the staff org is not
 * enough on its own: if ZITADEL self-registration is on, anyone could join that org. Customer and
 * vendor principals are scoped to their own org and keep working without a role. The check counts
 * the roles of the caller's own org only (`rolesInOrg`), the same list the principal carries.
 */
@Injectable()
export class TenancyInterceptor implements NestInterceptor {
  /** Insertion-ordered, so the first key is the oldest entry when the cap is reached. */
  private readonly users = new Map<string, UserCacheEntry>();

  constructor(
    private readonly orgs: OrgResolver,
    private readonly reflector: Reflector,
    private readonly directory: UserDirectory,
    private readonly roleCache: RoleCache,
    @Inject(CLOCK) private readonly now: Clock,
  ) {}

  async intercept(context: ExecutionContext, next: CallHandler): Promise<Observable<unknown>> {
    if (context.getType() !== 'http') {
      return next.handle();
    }
    const req = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const auth = req.auth;
    if (!auth) {
      return next.handle();
    }

    const org = await this.orgs.resolve(auth.zitadelOrgId);
    const roles = rolesInOrg(auth, org.orgKind);
    if (org.orgKind === 'staff' && roles.length === 0) {
      throw new ForbiddenException(NO_ROLE);
    }
    // `ctx().roles` carries the same per-org list as the principal, so `/v1/me` cannot show a role
    // granted in another org either.
    bindIdentity({
      tenantId: org.tenantId,
      organizationId: org.organizationId,
      orgKind: org.orgKind,
      userId: auth.userId,
      roles,
      tokenExp: auth.tokenExp,
    });

    const user = await this.resolveUser(auth.userId, org.tenantId, org.organizationId);
    const grants = await this.roleCache.grantsFor(org.tenantId, org.organizationId, roles);
    const principal: Principal = {
      userId: user.userId,
      zitadelUserId: auth.userId,
      tenantId: org.tenantId,
      organizationId: org.organizationId,
      orgKind: org.orgKind,
      roles,
      departmentId: user.departmentId,
      status: user.status,
      grants,
    };
    bindPrincipal(principal);

    this.enforce(context, principal);
    return next.handle();
  }

  /**
   * The route-level decision. `@Can` wins over `@AnyAuthenticated` at either level, so a method
   * `@Can` under a class `@AnyAuthenticated` (or the reverse) always gets the stricter check.
   */
  private enforce(context: ExecutionContext, principal: Principal): void {
    const targets = [context.getHandler(), context.getClass()];

    const action = this.reflector.getAllAndOverride<Permission | undefined>(CAN_KEY, targets);
    if (action !== undefined) {
      const decision = can(principal, action);
      if (!decision.allowed) throw forbidden(decision.reason);
      return;
    }

    const anyAuthenticated = this.reflector.getAllAndOverride<boolean | undefined>(
      ANY_AUTHENTICATED_KEY,
      targets,
    );
    if (anyAuthenticated === true) {
      // The same status rule as `can()`: only `active` acts; `invited` has not finished sign-up.
      if (principal.status !== 'active') throw forbidden('inactive_user');
      return;
    }

    // Deny by default: a protected route nobody marked is a bug, and refusing it is the safe side.
    throw forbidden('no_permission');
  }

  /**
   * `UserDirectory.resolve()`, reused for 60 s per tenant and ZITADEL user. Only answers are
   * cached; a failed lookup is retried on the next request.
   */
  private async resolveUser(
    zitadelUserId: string,
    tenantId: string,
    organizationId: string,
  ): Promise<ResolvedUser> {
    const key = `${tenantId}:${zitadelUserId}`;
    const cached = this.users.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.user;
    }

    const user = await this.directory.resolve({ zitadelUserId, tenantId, organizationId });

    this.users.delete(key);
    if (this.users.size >= USER_CACHE_MAX) {
      const oldest = this.users.keys().next();
      if (oldest.done !== true) this.users.delete(oldest.value);
    }
    // Expiry counts from when the lookup finished, as in OrgResolver.
    this.users.set(key, { user, expiresAt: this.now() + USER_CACHE_TTL_MS });
    return user;
  }
}
