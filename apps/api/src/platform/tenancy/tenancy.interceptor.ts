// The one enforcement point for every authenticated route: it completes the request context, builds
// the caller's `Principal` and applies the route's `@Can` / `@AnyAuthenticated` marker. Serves the
// NFRs "authorization is deny-by-default" and "< 5 ms per decision" (P1 plan §1, k-authz; §6.2;
// findings 3 and 4): a route with no marker is refused, and a warm request touches no database.
import { type OrgKind, type Permission, ROLE_KEYS, type RoleKey } from '@bos/contracts';
import {
  BadRequestException,
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
import { type EntityMembership, type ResolvedUser, UserDirectory } from '../authz/user-directory';
import { requestTx } from '../db/tx';
import { CLOCK, type Clock, IdpOrgResolver, type ResolvedIdpOrg } from './idp-org-resolver';
import { bindIdentity, bindPrincipal } from './request-context';

// Fixed text: it names no org, tenant or role, so the caller learns nothing about where it landed.
const NO_ROLE = 'No project role has been granted';

/** The request header naming the acting legal entity (ADR 0027 §4). Express lowercases header names. */
export const ENTITY_HEADER = 'x-entity-id';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * How long a `UserDirectory.resolve()` answer is reused. A deactivated user can act for at most
 * this long on one api instance; the role list itself comes from the token, so it is never stale.
 */
export const USER_CACHE_TTL_MS = 60_000;

/** Upper bound on cached users per instance, so a flood of distinct tokens cannot grow memory. */
export const USER_CACHE_MAX = 10_000;

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
  marketing: 'staff',
  customer_user: 'customer',
  vendor_user: 'vendor',
  pmo: 'staff',
  operations_head: 'staff',
  procurement: 'staff',
  warehouse: 'staff',
  operations_officer: 'staff',
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

/** CR-02: a staff caller with no effective role. Fixed text, so it reveals nothing (see NO_ROLE). */
const noRole = (): ForbiddenException =>
  new ForbiddenException({ code: 'forbidden', message: NO_ROLE, reason: 'no_permission' });

/**
 * The `X-Entity-Id` header, lowercased, or undefined when absent. Anything that is not exactly one
 * uuid (a repeated header, an empty value, a typo) is the caller's mistake: 400 `invalid_entity`.
 */
function requestedEntity(req: AuthenticatedRequest): string | undefined {
  const raw: unknown = req.headers[ENTITY_HEADER];
  if (raw === undefined) return undefined;
  if (typeof raw !== 'string' || !UUID.test(raw)) {
    throw new BadRequestException({
      code: 'bad_request',
      message: 'Bad request',
      reason: 'invalid_entity',
    });
  }
  return raw.toLowerCase();
}

/**
 * ADR 0027 §4 step 5: the entity the request acts for, and the staff membership that allows it.
 * An unknown entity and one the caller may not use are refused alike, so entities cannot be
 * enumerated.
 */
function actingEntity(
  idp: ResolvedIdpOrg,
  user: ResolvedUser,
  requested: string | undefined,
): { entityId: string; membership: EntityMembership | null } {
  if (idp.kind === 'staff') {
    const { memberships } = user;
    const membership =
      requested === undefined
        ? (memberships.find((m) => m.isDefault) ??
          (memberships.length === 1 ? memberships[0] : undefined))
        : memberships.find((m) => m.organizationId.toLowerCase() === requested);
    if (membership === undefined) throw forbidden('entity_not_permitted');
    return { entityId: membership.organizationId, membership };
  }
  // Portal users have no membership: they may name any entity of their tenant.
  const wanted = requested ?? idp.defaultEntityId?.toLowerCase();
  const entityId = idp.entityIds.find((id) => id.toLowerCase() === wanted);
  if (entityId === undefined) throw forbidden('entity_not_permitted');
  return { entityId, membership: null };
}

/**
 * ADR 0027 §3: effective roles = token roles ∩ the membership's `roleKeys` (null: all token roles).
 * BOS can only narrow, never widen. Portal callers have no membership and keep their token roles.
 */
function effectiveRoles(
  tokenRoles: readonly RoleKey[],
  membership: EntityMembership | null,
): readonly RoleKey[] {
  const allowed = membership?.roleKeys;
  if (allowed === null || allowed === undefined) return tokenRoles;
  return Object.freeze(tokenRoles.filter((role) => allowed.includes(role)));
}

/**
 * Completes the request context and enforces the route-level permission (ADR 0027 §4), in this
 * order: resolve the IdP org (cached 60 s) → token roles of that org's kind → UserDirectory.resolve
 * (cached 60 s) → the row must belong to that tenant and IdP org (R26) → the acting entity from
 * `X-Entity-Id` or the default → effective roles → grants from RoleCache → bindIdentity and
 * bindPrincipal → `@Can` / `@AnyAuthenticated` / deny.
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
    private readonly idpOrgs: IdpOrgResolver,
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

    const idp = await this.idpOrgs.resolve(auth.zitadelOrgId);
    const tokenRoles = rolesInOrg(auth, idp.kind);
    // Effective roles are a subset of the token roles, so a staff token with none is refused here,
    // before any user lookup (CR-02).
    if (idp.kind === 'staff' && tokenRoles.length === 0) throw noRole();
    const requested = requestedEntity(req);

    const user = await this.resolveUser(auth.userId, idp.tenantId, idp.idpOrgId);
    // The directory finds the row by ZITADEL id alone, and a cached answer is keyed by tenant only,
    // so the row may live in another tenant or IdP org than the token resolved to. Acting as that
    // row here would cross the boundary, so refuse before any principal exists (review R26).
    if (user.tenantId !== idp.tenantId || user.idpOrgId !== idp.idpOrgId) {
      throw forbidden('no_permission');
    }

    const { entityId, membership } = actingEntity(idp, user, requested);
    const roles = effectiveRoles(tokenRoles, membership);
    if (idp.kind === 'staff' && roles.length === 0) throw noRole();
    const departmentId = membership?.departmentId ?? null;

    const grants = await this.roleCache.grantsFor(idp.tenantId, entityId, roles);
    // `ctx().roles` carries the same effective list as the principal, so `/v1/me` cannot show a
    // role granted in another org, or one the membership narrowed away.
    bindIdentity({
      tenantId: idp.tenantId,
      organizationId: entityId,
      orgKind: idp.kind,
      partyId: idp.partyId,
      idpOrgId: idp.idpOrgId,
      userId: auth.userId,
      roles,
      departmentId,
      tokenExp: auth.tokenExp,
    });
    const principal: Principal = {
      userId: user.userId,
      zitadelUserId: auth.userId,
      tenantId: idp.tenantId,
      organizationId: entityId,
      orgKind: idp.kind,
      partyId: idp.partyId,
      idpOrgId: idp.idpOrgId,
      roles,
      departmentId,
      status: user.status,
      grants,
    };
    bindPrincipal(principal);

    this.enforce(context, principal);
    if (idp.kind === 'staff' && this.directory.recordActivity) {
      const { scope, actor } = requestTx();
      this.directory.recordActivity(scope, actor);
    }
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
    idpOrgId: string,
  ): Promise<ResolvedUser> {
    const key = `${tenantId}:${zitadelUserId}`;
    const cached = this.users.get(key);
    if (cached !== undefined && cached.expiresAt > this.now()) {
      return cached.user;
    }

    const user = await this.directory.resolve({ zitadelUserId, tenantId, idpOrgId });

    this.users.delete(key);
    if (this.users.size >= USER_CACHE_MAX) {
      const oldest = this.users.keys().next();
      if (oldest.done !== true) this.users.delete(oldest.value);
    }
    // Expiry counts from when the lookup finished, as in IdpOrgResolver.
    this.users.set(key, { user, expiresAt: this.now() + USER_CACHE_TTL_MS });
    return user;
  }
}
