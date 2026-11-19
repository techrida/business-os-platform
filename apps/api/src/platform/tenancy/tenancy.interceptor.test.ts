// Unit test of the deny-by-default enforcement point (P1 plan §6.2, findings 3 and 4) and of the
// request scope of ADR 0027 §4 (IdP org, acting entity, effective roles). The real interceptor,
// Reflector, decorators and `can()` run; only the IdP org lookup, the user directory and the role
// table are fakes, so each case isolates one rule of the route-level decision.
// Also covers CR-02 (P0): a staff principal must hold at least one project role in its own org.
import 'reflect-metadata';

import type { AccessLevel, Permission, RoleKey, Scope } from '@bos/contracts';
import { idpOrgs, organizations } from '@bos/db';
import {
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  ForbiddenException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../auth/claims';
import { CustomersController } from '../../modules/customers/customers.controller';
import { AnyAuthenticated, Can } from '../authz/decorators';
import { type Principal, principal } from '../authz/principal';
import type { RoleCache } from '../authz/role-cache';
import type { EntityMembership, ResolvedUser, UserDirectory } from '../authz/user-directory';
import type { Db } from '../db/db.module';
import { IdpOrgResolver, type ResolvedIdpOrg } from './idp-org-resolver';
import { ctx, runWithRequestStore, type RequestContext } from './request-context';
import { TenancyInterceptor, USER_CACHE_TTL_MS } from './tenancy.interceptor';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '55555555-5555-4555-8555-555555555555';
/** The tenant's legal entities: A is the default, B a second entity, C one the user is not a member of. */
const ENTITY_A = '22222222-2222-4222-8222-222222222222';
const ENTITY_B = '44444444-4444-4444-8444-444444444444';
const ENTITY_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
/** An entity of another tenant. */
const FOREIGN_ENTITY = '66666666-6666-4666-8666-666666666666';
const UNKNOWN_ENTITY = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const DEPT_B = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const CUSTOMER_PARTY = '88888888-8888-4888-8888-888888888888';
const VENDOR_PARTY = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

const STAFF: ResolvedIdpOrg = {
  idpOrgId: '99999999-9999-4999-8999-999999999999',
  tenantId: TENANT,
  kind: 'staff',
  partyId: null,
  entityIds: [ENTITY_A, ENTITY_B, ENTITY_C],
  defaultEntityId: ENTITY_A,
};
const CUSTOMER: ResolvedIdpOrg = {
  ...STAFF,
  idpOrgId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  kind: 'customer',
  partyId: CUSTOMER_PARTY,
};
const VENDOR: ResolvedIdpOrg = {
  ...STAFF,
  idpOrgId: '77777777-7777-4777-8777-777777777777',
  kind: 'vendor',
  partyId: VENDOR_PARTY,
};
/** A second IdP org of the same tenant (R26: a user row of the staff org must not act through it). */
const OTHER_IDP_SAME_TENANT: ResolvedIdpOrg = {
  ...STAFF,
  idpOrgId: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
};
const ZIT_ORG = 'zit-staff';
const OTHER_ZIT_ORG = 'zit-other';
const APP_USER_ID = '33333333-3333-4333-8333-333333333333';

const MEMBERSHIP_A: EntityMembership = {
  organizationId: ENTITY_A,
  isDefault: true,
  roleKeys: null,
  departmentId: null,
};
const MEMBERSHIP_B: EntityMembership = {
  organizationId: ENTITY_B,
  isDefault: false,
  roleKeys: ['sales'],
  departmentId: DEPT_B,
};

/** Role → grants, as the role table would hold them. */
const TABLE: Record<string, ReadonlyMap<Permission, Scope>> = {
  finance: new Map<Permission, Scope>([['admin.users.read', 'all']]),
  sales: new Map<Permission, Scope>([['approvals.requests.read', 'own']]),
};

class Routes {
  open(): string {
    return 'ok';
  }

  @Can('admin.users.read')
  readUsers(): string {
    return 'ok';
  }

  @AnyAuthenticated()
  me(): string {
    return 'ok';
  }
}

@AnyAuthenticated()
class OpenClassStrictMethod {
  @Can('admin.users.read')
  readUsers(): string {
    return 'ok';
  }

  plain(): string {
    return 'ok';
  }
}

@Can('admin.users.read')
class StrictClassOpenMethod {
  @AnyAuthenticated()
  me(): string {
    return 'ok';
  }
}

type Handler = (...args: never[]) => unknown;
type Req = { auth?: AuthIdentity; headers: Record<string, string | string[] | undefined> };

function httpContext(
  req: Req,
  cls: abstract new (...args: never[]) => unknown,
  handler: Handler,
): ExecutionContext {
  return {
    getType: () => 'http',
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => handler,
    getClass: () => cls,
  } as unknown as ExecutionContext;
}

const next: CallHandler = { handle: () => of('handled') };

function auth(rolesByOrg: Record<string, readonly RoleKey[]> | undefined): AuthIdentity {
  return {
    userId: 'zit-user-1',
    zitadelOrgId: ZIT_ORG,
    // The cross-org union P0 kept. The interceptor must never read it.
    roles: ['finance', 'founder', 'sales'],
    ...(rolesByOrg === undefined ? {} : { rolesByOrg }),
    tokenExp: 1_900_000_000,
  };
}

let now = 1_000_000;
let resolveCalls: number;
let resolveArgs: { zitadelUserId: string; tenantId: string; idpOrgId: string }[];
let status: Principal['status'];
let grantRequests: { organizationId: string; roles: readonly RoleKey[]; level: AccessLevel }[];
/** The IdP org the token resolves to. */
let tokenOrg: ResolvedIdpOrg;
/** The user row the directory returns: its tenant, IdP org and memberships. */
let row: { tenantId: string; idpOrgId: string; memberships: EntityMembership[] };
/** The role cache epoch; a test moves it to model `AuthzService.invalidate`. */
let epoch = '0:0';

const roleCache = {
  epoch: () => Promise.resolve(epoch),
  grantsFor: (
    _t: string,
    organizationId: string,
    roles: readonly RoleKey[],
    level: AccessLevel = 'staff',
  ) => {
    grantRequests.push({ organizationId, roles, level });
    const merged = new Map<Permission, Scope>();
    for (const role of roles) for (const [p, s] of TABLE[role] ?? []) merged.set(p, s);
    return Promise.resolve(merged);
  },
} as unknown as RoleCache;

function fakeDirectory(): UserDirectory {
  return {
    resolve: (i: { zitadelUserId: string; tenantId: string; idpOrgId: string }) => {
      resolveCalls += 1;
      resolveArgs.push(i);
      const user: ResolvedUser = { userId: APP_USER_ID, status, ...row };
      return Promise.resolve(user);
    },
  } as unknown as UserDirectory;
}

function build(): TenancyInterceptor {
  const orgs = { resolve: () => Promise.resolve(tokenOrg) } as unknown as IdpOrgResolver;
  return new TenancyInterceptor(orgs, new Reflector(), fakeDirectory(), roleCache, () => now);
}

/** An interceptor whose token and user row both resolve to the portal org `org` (no memberships). */
function buildFor(org: ResolvedIdpOrg): TenancyInterceptor {
  tokenOrg = org;
  row = { tenantId: org.tenantId, idpOrgId: org.idpOrgId, memberships: [] };
  return build();
}

interface Ran {
  result: unknown;
  bound: Principal;
  context: RequestContext;
  roles: readonly string[];
}

/** Runs one request through the interceptor; returns the handler result and what was bound. */
function run(
  interceptor: TenancyInterceptor,
  identity: AuthIdentity | undefined,
  cls: abstract new (...args: never[]) => unknown,
  handler: Handler,
  entityHeader?: string | string[],
): Promise<Ran> {
  const headers = entityHeader === undefined ? {} : { 'x-entity-id': entityHeader };
  return runWithRequestStore('corr-1', async () => {
    const observable = await interceptor.intercept(
      httpContext(identity === undefined ? { headers } : { auth: identity, headers }, cls, handler),
      next,
    );
    const context = ctx();
    return {
      result: await lastValueFrom(observable),
      bound: principal(),
      context,
      roles: context.roles,
    };
  });
}

/** The 403 body the interceptor threw, or a failure if it let the request through. */
async function denial(promise: Promise<unknown>): Promise<Record<string, unknown>> {
  const err: unknown = await promise.then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ForbiddenException);
  return (err as ForbiddenException).getResponse() as Record<string, unknown>;
}

/**
 * Runs one request that must be refused, inside the request store, and reports whether a principal
 * was bound before the refusal: `run()` rejects before it can look.
 */
function refusedRun(
  interceptor: TenancyInterceptor,
  identity: AuthIdentity,
  handler: Handler,
  entityHeader?: string,
): Promise<{ err: unknown; principalBound: boolean }> {
  const headers = entityHeader === undefined ? {} : { 'x-entity-id': entityHeader };
  return runWithRequestStore('corr-1', async () => {
    const err: unknown = await interceptor
      .intercept(httpContext({ auth: identity, headers }, Routes, handler), next)
      .then(
        () => undefined,
        (e: unknown) => e,
      );
    let principalBound = true;
    try {
      principal();
    } catch {
      principalBound = false;
    }
    return { err, principalBound };
  });
}

const ENTITY_DENIED = { code: 'forbidden', message: 'Forbidden', reason: 'entity_not_permitted' };

describe('TenancyInterceptor', () => {
  let interceptor: TenancyInterceptor;

  it('refuses the real customer search handler when the caller lacks customer.read', async () => {
    const result = await denial(
      run(
        interceptor,
        auth({ [ZIT_ORG]: ['sales'] }),
        CustomersController,
        CustomersController.prototype.list,
      ),
    );
    expect(result).toEqual({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });
  });

  beforeEach(() => {
    now = 1_000_000;
    epoch = '0:0';
    resolveCalls = 0;
    resolveArgs = [];
    status = 'active';
    grantRequests = [];
    tokenOrg = STAFF;
    row = {
      tenantId: STAFF.tenantId,
      idpOrgId: STAFF.idpOrgId,
      memberships: [MEMBERSHIP_A, MEMBERSHIP_B],
    };
    interceptor = build();
  });

  const finance = { [ZIT_ORG]: ['finance'] as RoleKey[] };
  const financeAndSales = { [ZIT_ORG]: ['finance', 'sales'] as RoleKey[] };

  it('refuses a protected route with no marker (deny by default)', async () => {
    const body = await denial(run(interceptor, auth(finance), Routes, Routes.prototype.open));
    expect(body).toEqual({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });
  });

  it('lets @Can through when the role grants it, and binds the principal', async () => {
    const { result, bound, roles } = await run(
      interceptor,
      auth(finance),
      Routes,
      Routes.prototype.readUsers,
    );
    expect(result).toBe('handled');
    expect(bound).toMatchObject({
      userId: APP_USER_ID,
      zitadelUserId: 'zit-user-1',
      tenantId: TENANT,
      organizationId: ENTITY_A,
      orgKind: 'staff',
      partyId: null,
      idpOrgId: STAFF.idpOrgId,
      roles: ['finance'],
      departmentId: null,
      status: 'active',
    });
    expect(bound.grants.get('admin.users.read')).toBe('all');
    expect(roles).toEqual(['finance']);
  });

  it('refuses @Can with no_permission when no role grants it', async () => {
    const sales = { [ZIT_ORG]: ['sales'] as RoleKey[] };
    const body = await denial(run(interceptor, auth(sales), Routes, Routes.prototype.readUsers));
    expect(body).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
  });

  it.each(['inactive', 'invited'] as const)(
    'refuses a %s user with inactive_user on @Can and on @AnyAuthenticated',
    async (s) => {
      status = s;
      const onCan = await denial(
        run(interceptor, auth(finance), Routes, Routes.prototype.readUsers),
      );
      expect(onCan).toMatchObject({ reason: 'inactive_user' });
      const onAny = await denial(run(interceptor, auth(finance), Routes, Routes.prototype.me));
      expect(onAny).toMatchObject({ reason: 'inactive_user' });
    },
  );

  it('lets an active customer or vendor user with no roles through @AnyAuthenticated', async () => {
    for (const org of [CUSTOMER, VENDOR]) {
      const { result, bound, roles } = await run(
        buildFor(org),
        auth({}),
        Routes,
        Routes.prototype.me,
      );
      expect(result).toBe('handled');
      expect(bound).toMatchObject({ orgKind: org.kind, roles: [] });
      expect(roles).toEqual([]);
    }
  });

  it('refuses a staff principal with no role in its org (CR-02), naming no tenant or org', async () => {
    const body = await denial(run(interceptor, auth({}), Routes, Routes.prototype.me));
    const text = JSON.stringify(body);
    expect(text).toContain('No project role has been granted');
    expect(text).not.toContain(TENANT);
    expect(text).not.toContain(ENTITY_A);
    // Refused before the user lookup and the role table are touched.
    expect(resolveCalls).toBe(0);
    expect(grantRequests).toEqual([]);
  });

  it('lets a staff principal with a role in its org through @AnyAuthenticated (CR-02)', async () => {
    const founder = { [ZIT_ORG]: ['founder'] as RoleKey[] };
    const { result, roles } = await run(interceptor, auth(founder), Routes, Routes.prototype.me);
    expect(result).toBe('handled');
    expect(roles).toEqual(['founder']);
  });

  it('ignores a role granted only in another org, and never falls back to the union', async () => {
    // Staff with roles only elsewhere have no role here, so CR-02 refuses them before any grant
    // lookup. Had the interceptor fallen back to the union (finance, founder, sales), they would pass.
    const elsewhere = { [OTHER_ZIT_ORG]: ['finance'] as RoleKey[] };
    const body = await denial(
      run(interceptor, auth(elsewhere), Routes, Routes.prototype.readUsers),
    );
    expect(JSON.stringify(body)).toContain('No project role has been granted');
    expect(grantRequests).toEqual([]);

    // No `rolesByOrg` at all (a P0-shaped identity): still no roles, despite `roles` listing three.
    const p0Shaped = await denial(run(interceptor, auth(undefined), Routes, Routes.prototype.me));
    expect(JSON.stringify(p0Shaped)).toContain('No project role has been granted');

    // In a customer org the same identity resolves to no roles and is let through @AnyAuthenticated.
    const { roles, bound } = await run(
      buildFor(CUSTOMER),
      auth(undefined),
      Routes,
      Routes.prototype.me,
    );
    expect(roles).toEqual([]);
    expect(bound.roles).toEqual([]);
  });

  it('keeps only known role keys', async () => {
    const mixed = { [ZIT_ORG]: ['finance', 'superuser'] as unknown as RoleKey[] };
    const { bound } = await run(interceptor, auth(mixed), Routes, Routes.prototype.me);
    expect(bound.roles).toEqual(['finance']);
  });

  it('accepts the P2 staff roles in a staff org and drops them in a customer org', async () => {
    const p2Roles: RoleKey[] = [
      'pmo',
      'operations_head',
      'procurement',
      'warehouse',
      'operations_officer',
    ];
    // Without an entry in ROLE_ORG_KIND these were filtered out, which left a staff token with no role.
    const staff = await run(interceptor, auth({ [ZIT_ORG]: p2Roles }), Routes, Routes.prototype.me);
    expect(staff.bound.roles).toEqual(p2Roles);

    const portal = await run(
      buildFor(CUSTOMER),
      auth({ [ZIT_ORG]: p2Roles }),
      Routes,
      Routes.prototype.me,
    );
    expect(portal.bound.roles).toEqual([]);
  });

  it('a method @Can beats a class @AnyAuthenticated', async () => {
    const sales = { [ZIT_ORG]: ['sales'] as RoleKey[] };
    const body = await denial(
      run(
        interceptor,
        auth(sales),
        OpenClassStrictMethod,
        OpenClassStrictMethod.prototype.readUsers,
      ),
    );
    expect(body).toMatchObject({ reason: 'no_permission' });
    // The class marker still covers the unmarked method.
    const { result } = await run(
      interceptor,
      auth(sales),
      OpenClassStrictMethod,
      OpenClassStrictMethod.prototype.plain,
    );
    expect(result).toBe('handled');
  });

  it('a class @Can beats a method @AnyAuthenticated', async () => {
    const sales = { [ZIT_ORG]: ['sales'] as RoleKey[] };
    const body = await denial(
      run(interceptor, auth(sales), StrictClassOpenMethod, StrictClassOpenMethod.prototype.me),
    );
    expect(body).toMatchObject({ reason: 'no_permission' });
  });

  it('passes a public route (no req.auth) through untouched', async () => {
    const result = await runWithRequestStore('corr-1', async () => {
      const observable = await interceptor.intercept(
        httpContext({ headers: {} }, Routes, Routes.prototype.open),
        next,
      );
      expect(() => ctx()).toThrow();
      return lastValueFrom(observable);
    });
    expect(result).toBe('handled');
    expect(resolveCalls).toBe(0);
  });

  it('reuses UserDirectory.resolve for 60 s, then asks again', async () => {
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    now += USER_CACHE_TTL_MS - 1;
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(resolveCalls).toBe(1);

    now += 1;
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(resolveCalls).toBe(2);
  });

  it('asks the directory again at once when access was changed (the role cache epoch moved)', async () => {
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    epoch = '1:0';
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(resolveCalls).toBe(2);
  });

  it('asks the directory with the tenant and the token IdP org', async () => {
    await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(resolveArgs).toEqual([
      { zitadelUserId: 'zit-user-1', tenantId: TENANT, idpOrgId: STAFF.idpOrgId },
    ]);
  });

  // R26: the directory looks a user up by ZITADEL id alone, so the row it returns must belong to the
  // tenant and IdP org the token resolved to, or the request would act as that row in another scope.
  it.each([
    [
      'another IdP org of the same tenant',
      { tenantId: TENANT, idpOrgId: OTHER_IDP_SAME_TENANT.idpOrgId },
    ],
    ['another tenant', { tenantId: OTHER_TENANT, idpOrgId: STAFF.idpOrgId }],
  ])('refuses a user row from %s with no_permission and binds no principal', async (_, scope) => {
    row = { ...row, ...scope };
    for (const handler of [Routes.prototype.readUsers, Routes.prototype.me]) {
      const { err, principalBound } = await refusedRun(interceptor, auth(finance), handler);
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'forbidden',
        message: 'Forbidden',
        reason: 'no_permission',
      });
      expect(principalBound).toBe(false);
    }
  });

  it('refuses a cached user row once the token resolves to another IdP org of the tenant', async () => {
    const { result } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(result).toBe('handled');

    // The cache key is tenant + ZITADEL user, so this hit reuses the staff row without a lookup.
    tokenOrg = OTHER_IDP_SAME_TENANT;
    const { err, principalBound } = await refusedRun(
      interceptor,
      auth(finance),
      Routes.prototype.me,
    );
    expect(resolveCalls).toBe(1);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ reason: 'no_permission' });
    expect(principalBound).toBe(false);
  });

  describe('acting entity (X-Entity-Id, ADR 0027 §4)', () => {
    it('uses the default membership when there is no header', async () => {
      const { context, bound } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
      expect(context.organizationId).toBe(ENTITY_A);
      expect(bound.organizationId).toBe(ENTITY_A);
      expect(grantRequests[0]?.organizationId).toBe(ENTITY_A);
    });

    it('uses the only membership when none is marked default', async () => {
      row.memberships = [{ ...MEMBERSHIP_B, roleKeys: null }];
      const { context } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
      expect(context.organizationId).toBe(ENTITY_B);
    });

    it('refuses with entity_not_permitted when no membership is default and there are several', async () => {
      row.memberships = [
        { ...MEMBERSHIP_A, isDefault: false },
        { ...MEMBERSHIP_B, roleKeys: null },
      ];
      const body = await denial(run(interceptor, auth(finance), Routes, Routes.prototype.me));
      expect(body).toEqual(ENTITY_DENIED);
    });

    it('refuses a staff user with no membership at all', async () => {
      row.memberships = [];
      const body = await denial(run(interceptor, auth(finance), Routes, Routes.prototype.me));
      expect(body).toEqual(ENTITY_DENIED);
    });

    it('acts for the membership the header names, binding its department', async () => {
      const { context, bound } = await run(
        interceptor,
        auth(financeAndSales),
        Routes,
        Routes.prototype.me,
        ENTITY_B,
      );
      expect(context).toMatchObject({ organizationId: ENTITY_B, departmentId: DEPT_B });
      expect(bound).toMatchObject({ organizationId: ENTITY_B, departmentId: DEPT_B });
    });

    it('asks the role cache for the membership level and binds it on the principal', async () => {
      row.memberships = [MEMBERSHIP_A, { ...MEMBERSHIP_B, level: 'manager' }];
      const { bound } = await run(
        interceptor,
        auth(financeAndSales),
        Routes,
        Routes.prototype.me,
        ENTITY_B,
      );
      expect(grantRequests).toEqual([
        { organizationId: ENTITY_B, roles: ['sales'], level: 'manager' },
      ]);
      expect(bound).toMatchObject({ departmentId: DEPT_B, level: 'manager' });
    });

    it('asks for staff grants when the member has no department, but keeps the real level', async () => {
      // A level widens a grant to the department; with none there is nothing to widen to (Check a person agrees).
      row.memberships = [{ ...MEMBERSHIP_A, level: 'manager' }, MEMBERSHIP_B];
      const { bound } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
      expect(grantRequests).toEqual([
        { organizationId: ENTITY_A, roles: ['finance'], level: 'staff' },
      ]);
      expect(bound).toMatchObject({ departmentId: null, level: 'manager' });
    });

    it('reads a membership without a level as staff', async () => {
      const { bound } = await run(
        interceptor,
        auth(financeAndSales),
        Routes,
        Routes.prototype.me,
        ENTITY_B,
      );
      expect(grantRequests[0]?.level).toBe('staff');
      expect(bound.level).toBe('staff');
    });

    it('accepts the header in upper case', async () => {
      const { context } = await run(
        interceptor,
        auth(finance),
        Routes,
        Routes.prototype.me,
        ENTITY_A.toUpperCase(),
      );
      expect(context.organizationId).toBe(ENTITY_A);
    });

    it('answers a non-member entity and an unknown entity alike: 403 entity_not_permitted', async () => {
      const nonMember = await refusedRun(interceptor, auth(finance), Routes.prototype.me, ENTITY_C);
      const unknown = await refusedRun(
        interceptor,
        auth(finance),
        Routes.prototype.me,
        UNKNOWN_ENTITY,
      );
      for (const { err, principalBound } of [nonMember, unknown]) {
        expect(err).toBeInstanceOf(ForbiddenException);
        expect((err as ForbiddenException).getResponse()).toEqual(ENTITY_DENIED);
        expect(principalBound).toBe(false);
      }
    });

    it.each([['not-a-uuid'], [''], [`${ENTITY_A}x`], [[ENTITY_A, ENTITY_B]]])(
      'refuses a malformed header %j with 400 invalid_entity',
      async (header) => {
        const err: unknown = await run(
          interceptor,
          auth(finance),
          Routes,
          Routes.prototype.me,
          header,
        ).then(
          () => undefined,
          (e: unknown) => e,
        );
        expect(err).toBeInstanceOf(BadRequestException);
        expect((err as BadRequestException).getStatus()).toBe(400);
        expect((err as BadRequestException).getResponse()).toEqual({
          code: 'bad_request',
          message: 'Bad request',
          reason: 'invalid_entity',
        });
      },
    );

    it('narrows the token roles to the membership roleKeys', async () => {
      const { bound, roles } = await run(
        interceptor,
        auth(financeAndSales),
        Routes,
        Routes.prototype.me,
        ENTITY_B,
      );
      expect(bound.roles).toEqual(['sales']);
      expect(roles).toEqual(['sales']);
      expect(grantRequests).toEqual([
        { organizationId: ENTITY_B, roles: ['sales'], level: 'staff' },
      ]);
      // Narrowed away: finance's admin.users.read is not granted in entity B.
      const body = await denial(
        run(interceptor, auth(financeAndSales), Routes, Routes.prototype.readUsers, ENTITY_B),
      );
      expect(body).toMatchObject({ reason: 'no_permission' });
    });

    it('refuses a staff user whose narrowed roles are empty, with the CR-02 body', async () => {
      const { err, principalBound } = await refusedRun(
        interceptor,
        auth(finance),
        Routes.prototype.me,
        ENTITY_B,
      );
      expect(err).toBeInstanceOf(ForbiddenException);
      expect((err as ForbiddenException).getResponse()).toEqual({
        code: 'forbidden',
        message: 'No project role has been granted',
        reason: 'no_permission',
      });
      expect(principalBound).toBe(false);
      expect(grantRequests).toEqual([]);
    });

    it('binds partyId and idpOrgId for a portal user, in the tenant default entity', async () => {
      const { context, bound } = await run(
        buildFor(CUSTOMER),
        auth({}),
        Routes,
        Routes.prototype.me,
      );
      expect(context).toMatchObject({
        organizationId: ENTITY_A,
        orgKind: 'customer',
        partyId: CUSTOMER_PARTY,
        idpOrgId: CUSTOMER.idpOrgId,
        departmentId: null,
      });
      expect(bound).toMatchObject({
        organizationId: ENTITY_A,
        partyId: CUSTOMER_PARTY,
        idpOrgId: CUSTOMER.idpOrgId,
        departmentId: null,
        // No membership, so no level: a portal caller gets no level grant.
        level: 'staff',
      });
      expect(grantRequests.every((g) => g.level === 'staff')).toBe(true);
    });

    it('lets a portal user name another entity of the tenant, keeping its token roles', async () => {
      const customerRole = { [ZIT_ORG]: ['customer_user'] as RoleKey[] };
      const { context } = await run(
        buildFor(CUSTOMER),
        auth(customerRole),
        Routes,
        Routes.prototype.me,
        ENTITY_C,
      );
      expect(context).toMatchObject({ organizationId: ENTITY_C, roles: ['customer_user'] });
    });

    it('refuses a portal user naming an entity of another tenant', async () => {
      const body = await denial(
        run(buildFor(CUSTOMER), auth({}), Routes, Routes.prototype.me, FOREIGN_ENTITY),
      );
      expect(body).toEqual(ENTITY_DENIED);
    });

    it('refuses a portal user with no header when the tenant has no default entity', async () => {
      const body = await denial(
        run(
          buildFor({ ...CUSTOMER, defaultEntityId: null }),
          auth({}),
          Routes,
          Routes.prototype.me,
        ),
      );
      expect(body).toEqual(ENTITY_DENIED);
    });
  });

  it('makes zero database or directory calls on a warm request (real IdpOrgResolver)', async () => {
    let dbQueries = 0;
    const db = {
      select: () => ({
        from: (table: unknown) => ({
          where: () => {
            dbQueries += 1;
            if (table === idpOrgs) {
              return {
                limit: () =>
                  Promise.resolve([
                    {
                      idpOrgId: STAFF.idpOrgId,
                      tenantId: TENANT,
                      kind: 'staff',
                      partyId: null,
                    },
                  ]),
              };
            }
            if (table === organizations) {
              return Promise.resolve([
                { id: ENTITY_A, isDefault: true },
                { id: ENTITY_B, isDefault: false },
              ]);
            }
            throw new Error('unexpected table');
          },
        }),
      }),
    } as unknown as Db;
    const resolver = new IdpOrgResolver(db, () => now);
    const warm = new TenancyInterceptor(
      resolver,
      new Reflector(),
      fakeDirectory(),
      roleCache,
      () => now,
    );

    await run(warm, auth(financeAndSales), Routes, Routes.prototype.me);
    const coldQueries = dbQueries;
    const coldResolves = resolveCalls;
    expect(coldQueries).toBe(2);
    expect(coldResolves).toBe(1);

    now += 1_000;
    const { context } = await run(
      warm,
      auth(financeAndSales),
      Routes,
      Routes.prototype.me,
      ENTITY_B,
    );
    expect(context.organizationId).toBe(ENTITY_B);
    expect(dbQueries - coldQueries).toBe(0);
    expect(resolveCalls - coldResolves).toBe(0);
  });

  it('builds a principal from warm caches in under 1 ms', async () => {
    await run(interceptor, auth(finance), Routes, Routes.prototype.readUsers);

    const samples: number[] = [];
    for (let i = 0; i < 1_000; i += 1) {
      const start = performance.now();
      await run(interceptor, auth(finance), Routes, Routes.prototype.readUsers);
      samples.push(performance.now() - start);
    }
    samples.sort((a, b) => a - b);
    const p95 = samples[Math.floor(samples.length * 0.95)] ?? Number.POSITIVE_INFINITY;
    expect(resolveCalls).toBe(1);
    // p95, not a single run: the agent-check copy shares a noisy machine.
    expect(p95).toBeLessThan(1);
  });
});
