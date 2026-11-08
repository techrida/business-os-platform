// Unit test of the deny-by-default enforcement point (P1 plan §6.2, findings 3 and 4). The real
// interceptor, Reflector, decorators and `can()` run; only the org lookup, the user directory and
// the role table are fakes, so each case isolates one rule of the route-level decision.
// Also covers CR-02 (P0): a staff principal must hold at least one project role in its own org.
import 'reflect-metadata';

import type { Permission, RoleKey, Scope } from '@bos/contracts';
import { type CallHandler, type ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { lastValueFrom, of } from 'rxjs';
import { beforeEach, describe, expect, it } from 'vitest';

import type { AuthIdentity } from '../auth/claims';
import { AnyAuthenticated, Can } from '../authz/decorators';
import { type Principal, principal } from '../authz/principal';
import type { RoleCache } from '../authz/role-cache';
import type { UserDirectory } from '../authz/user-directory';
import type { OrgResolver, ResolvedOrg } from './org-resolver';
import { ctx, runWithRequestStore } from './request-context';
import { TenancyInterceptor, USER_CACHE_TTL_MS } from './tenancy.interceptor';

const STAFF: ResolvedOrg = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  organizationId: '22222222-2222-4222-8222-222222222222',
  orgKind: 'staff',
};
const CUSTOMER: ResolvedOrg = {
  tenantId: STAFF.tenantId,
  organizationId: '66666666-6666-4666-8666-666666666666',
  orgKind: 'customer',
};
const VENDOR: ResolvedOrg = {
  tenantId: STAFF.tenantId,
  organizationId: '77777777-7777-4777-8777-777777777777',
  orgKind: 'vendor',
};
const ZIT_ORG = 'zit-staff';
const OTHER_ZIT_ORG = 'zit-other';
const APP_USER_ID = '33333333-3333-4333-8333-333333333333';

/** Role → grants, as the role table would hold them for this org. */
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

function httpContext(
  req: { auth?: AuthIdentity },
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

/** A second org in the same tenant, and an org of another tenant, for the R26 row-scope checks. */
const OTHER_ORG_SAME_TENANT: ResolvedOrg = {
  ...STAFF,
  organizationId: '44444444-4444-4444-8444-444444444444',
};
const OTHER_TENANT: ResolvedOrg = {
  ...STAFF,
  tenantId: '55555555-5555-4555-8555-555555555555',
};

let now = 1_000_000;
let resolveCalls: number;
let status: Principal['status'];
let grantRequests: (readonly RoleKey[])[];
/** The org the token resolves to. */
let tokenOrg: ResolvedOrg;
/** Where the user row the directory returns lives. */
let rowScope: { tenantId: string; organizationId: string };

function build(): TenancyInterceptor {
  const orgs = { resolve: () => Promise.resolve(tokenOrg) } as unknown as OrgResolver;
  const directory = {
    resolve: () => {
      resolveCalls += 1;
      return Promise.resolve({
        userId: APP_USER_ID,
        status,
        departmentId: null,
        tenantId: rowScope.tenantId,
        organizationId: rowScope.organizationId,
      });
    },
  } as unknown as UserDirectory;
  const roleCache = {
    grantsFor: (_t: string, _o: string, roles: readonly RoleKey[]) => {
      grantRequests.push(roles);
      const merged = new Map<Permission, Scope>();
      for (const role of roles) for (const [p, s] of TABLE[role] ?? []) merged.set(p, s);
      return Promise.resolve(merged);
    },
  } as unknown as RoleCache;
  return new TenancyInterceptor(orgs, new Reflector(), directory, roleCache, () => now);
}

/** An interceptor whose token and user row both resolve to `org` (CR-02 cases outside staff). */
function buildFor(org: ResolvedOrg): TenancyInterceptor {
  tokenOrg = org;
  rowScope = { tenantId: org.tenantId, organizationId: org.organizationId };
  return build();
}

/** Runs one request through the interceptor; returns the handler result and the bound principal. */
function run(
  interceptor: TenancyInterceptor,
  identity: AuthIdentity | undefined,
  cls: abstract new (...args: never[]) => unknown,
  handler: Handler,
): Promise<{ result: unknown; bound: Principal; roles: readonly string[] }> {
  return runWithRequestStore('corr-1', async () => {
    const observable = await interceptor.intercept(
      httpContext(identity === undefined ? {} : { auth: identity }, cls, handler),
      next,
    );
    return { result: await lastValueFrom(observable), bound: principal(), roles: ctx().roles };
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
): Promise<{ err: unknown; principalBound: boolean }> {
  return runWithRequestStore('corr-1', async () => {
    const err: unknown = await interceptor
      .intercept(httpContext({ auth: identity }, Routes, handler), next)
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

describe('TenancyInterceptor', () => {
  let interceptor: TenancyInterceptor;

  beforeEach(() => {
    now = 1_000_000;
    resolveCalls = 0;
    status = 'active';
    grantRequests = [];
    tokenOrg = STAFF;
    rowScope = { tenantId: STAFF.tenantId, organizationId: STAFF.organizationId };
    interceptor = build();
  });

  const finance = { [ZIT_ORG]: ['finance'] as RoleKey[] };

  it('refuses a protected route with no marker (deny by default)', async () => {
    const body = await denial(run(interceptor, auth(finance), Routes, Routes.prototype.open));
    expect(body).toEqual({ code: 'forbidden', message: 'Forbidden', reason: 'no_permission' });
  });

  it('lets @Can through when the org role grants it, and binds the principal', async () => {
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
      tenantId: STAFF.tenantId,
      organizationId: STAFF.organizationId,
      orgKind: 'staff',
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
      expect(bound).toMatchObject({ orgKind: org.orgKind, roles: [] });
      expect(roles).toEqual([]);
    }
  });

  it('refuses a staff principal with no role in its org (CR-02), naming no tenant or org', async () => {
    const body = await denial(run(interceptor, auth({}), Routes, Routes.prototype.me));
    const text = JSON.stringify(body);
    expect(text).toContain('No project role has been granted');
    expect(text).not.toContain(STAFF.tenantId);
    expect(text).not.toContain(STAFF.organizationId);
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
        httpContext({}, Routes, Routes.prototype.open),
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

  // R26: the directory looks a user up by ZITADEL id alone, so the row it returns must belong to the
  // tenant and org the token resolved to, or the request would act as that row in another scope.
  it.each([
    ['another org of the same tenant', OTHER_ORG_SAME_TENANT],
    ['another tenant', OTHER_TENANT],
  ])('refuses a user row from %s with no_permission and binds no principal', async (_, rowOrg) => {
    rowScope = { tenantId: rowOrg.tenantId, organizationId: rowOrg.organizationId };
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

  it('refuses a cached user row once the token resolves to another org of the tenant', async () => {
    const { result } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(result).toBe('handled');

    // The cache key is tenant + ZITADEL user, so this hit reuses the STAFF row without a lookup.
    tokenOrg = OTHER_ORG_SAME_TENANT;
    const { err, principalBound } = await refusedRun(
      interceptor,
      auth(finance),
      Routes.prototype.me,
    );
    expect(resolveCalls).toBe(1);
    expect((err as ForbiddenException).getResponse()).toMatchObject({ reason: 'no_permission' });
    expect(principalBound).toBe(false);
  });

  it('lets a user row of the token org through', async () => {
    const { result, bound } = await run(interceptor, auth(finance), Routes, Routes.prototype.me);
    expect(result).toBe('handled');
    expect(bound).toMatchObject({
      tenantId: STAFF.tenantId,
      organizationId: STAFF.organizationId,
    });
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
