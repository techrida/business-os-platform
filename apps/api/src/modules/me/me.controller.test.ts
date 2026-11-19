import {
  DEFAULT_ROLE_PERMISSIONS,
  MeResponseSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { authzVersions } from '@bos/db';
import { describe, expect, it } from 'vitest';

import { type Principal } from '../../platform/authz/principal';
import { RoleCache } from '../../platform/authz/role-cache';
import { type Db } from '../../platform/db/db.module';
import {
  bindIdentity,
  bindPrincipal,
  runWithRequestStore,
} from '../../platform/tenancy/request-context';
import { MeController } from './me.controller';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ENTITY = '22222222-2222-4222-8222-222222222222';
const APP_USER = '33333333-3333-4333-8333-333333333333';
const DEPARTMENT = '44444444-4444-4444-8444-444444444444';
const IDP_ORG = '99999999-9999-4999-8999-999999999999';
const SUB = '312345678901234567';

type Row = { roleKey: RoleKey; permission: string; scope: string };

/**
 * A RoleCache over a fake database holding `rows` as the tenant's `role_permissions` (version 1). The cache's own
 * merge runs, so the principal carries exactly what the interceptor would build from the live table.
 */
function cacheOver(rows: readonly Row[]): RoleCache {
  const db = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => {
          const result = Promise.resolve(table === authzVersions ? [{ version: 1 }] : [...rows]);
          return Object.assign(result, { limit: () => result });
        },
      }),
    }),
  } as unknown as Db;
  return new RoleCache(db, () => 0);
}

function principalOf(
  roles: RoleKey[],
  grants: ReadonlyMap<Permission, Scope>,
  status: Principal['status'] = 'active',
): Principal {
  return {
    userId: APP_USER,
    zitadelUserId: SUB,
    tenantId: TENANT,
    organizationId: ENTITY,
    orgKind: 'staff',
    partyId: null,
    idpOrgId: IDP_ORG,
    roles,
    departmentId: DEPARTMENT,
    status,
    grants,
  };
}

/** GET /v1/me as `p`, through the real request store the interceptor binds. */
function meAs(p: Principal) {
  return runWithRequestStore('corr-12345678', () => {
    bindIdentity({
      tenantId: p.tenantId,
      organizationId: p.organizationId,
      orgKind: p.orgKind,
      partyId: p.partyId,
      idpOrgId: p.idpOrgId,
      userId: p.zitadelUserId,
      roles: [...p.roles],
      departmentId: p.departmentId,
      tokenExp: 1_900_000_000,
    });
    bindPrincipal(p);
    return new MeController().me();
  });
}

describe('MeController', () => {
  it('returns a MeResponse built from the request context and the principal', () => {
    const roles = ['admin', 'sales'];
    const body = runWithRequestStore('corr-12345678', () => {
      bindIdentity({
        tenantId: TENANT,
        organizationId: ENTITY,
        orgKind: 'customer',
        partyId: '88888888-8888-4888-8888-888888888888',
        idpOrgId: IDP_ORG,
        userId: SUB,
        roles,
        departmentId: null,
        tokenExp: 1_900_000_000,
      });
      bindPrincipal({
        ...principalOf(['customer_user'], new Map([['portal.quotation.read', 'customer_org']])),
        orgKind: 'customer',
      });
      return new MeController().me();
    });

    expect(MeResponseSchema.parse(body)).toEqual({
      userId: SUB,
      tenantId: TENANT,
      organizationId: ENTITY,
      orgKind: 'customer',
      partyId: '88888888-8888-4888-8888-888888888888',
      roles: ['admin', 'sales'],
      correlationId: 'corr-12345678',
      permissions: [{ permission: 'portal.quotation.read', scope: 'customer_org' }],
    });
    expect(body.roles).not.toBe(roles);
    // tokenExp, idpOrgId and departmentId are internal: they must not leak into the response.
    expect(body).not.toHaveProperty('tokenExp');
    expect(body).not.toHaveProperty('idpOrgId');
    expect(body).not.toHaveProperty('departmentId');
  });

  it('throws outside an authenticated request', () => {
    expect(() => new MeController().me()).toThrow('outside a request');
  });

  it('answers the live role rows, not the default grants, for a role an admin edited (sales)', async () => {
    // An admin took `customer.write` away from sales and widened `verification.read` to every case.
    const rows: Row[] = [
      { roleKey: 'sales', permission: 'customer.read', scope: 'all' },
      { roleKey: 'sales', permission: 'verification.read', scope: 'all' },
      { roleKey: 'sales', permission: 'quotation.read', scope: 'own' },
      { roleKey: 'pmo', permission: 'verification.review', scope: 'all' },
    ];
    const grants = await cacheOver(rows).grantsFor(TENANT, ENTITY, ['sales']);
    const body = meAs(principalOf(['sales'], grants));

    expect(MeResponseSchema.parse(body).permissions).toEqual([
      { permission: 'customer.read', scope: 'all' },
      { permission: 'quotation.read', scope: 'own' },
      { permission: 'verification.read', scope: 'all' },
    ]);
    // The defaults would say otherwise on both counts, so the answer cannot have come from them.
    expect(DEFAULT_ROLE_PERMISSIONS.sales['customer.write']).toBe('all');
    expect(DEFAULT_ROLE_PERMISSIONS.sales['verification.read']).toBe('own');
    expect(body.permissions?.some((g) => g.permission === 'customer.write')).toBe(false);
    // Another role's row (pmo's review) is not the caller's.
    expect(body.permissions?.some((g) => g.permission === 'verification.review')).toBe(false);
  });

  it('reports the own scope of a seeded sales user, and the widest scope across roles', async () => {
    const rows: Row[] = [
      ...Object.entries(DEFAULT_ROLE_PERMISSIONS.sales).map(([permission, scope]) => ({
        roleKey: 'sales' as const,
        permission,
        scope,
      })),
      ...Object.entries(DEFAULT_ROLE_PERMISSIONS.pmo).map(([permission, scope]) => ({
        roleKey: 'pmo' as const,
        permission,
        scope,
      })),
    ];
    const cache = cacheOver(rows);

    const sales = meAs(principalOf(['sales'], await cache.grantsFor(TENANT, ENTITY, ['sales'])));
    const scopes = new Map(sales.permissions?.map((g) => [g.permission, g.scope]));
    expect(scopes.get('verification.read')).toBe('own');
    expect(scopes.get('quotation.read')).toBe('own');
    expect(scopes.get('sales_order.read')).toBe('own');
    expect(scopes.get('customer.write')).toBe('all');
    expect(scopes.has('verification.review')).toBe(false);
    expect(sales.permissions).toHaveLength(Object.keys(DEFAULT_ROLE_PERMISSIONS.sales).length);

    const both = meAs(
      principalOf(['sales', 'pmo'], await cache.grantsFor(TENANT, ENTITY, ['sales', 'pmo'])),
    );
    const merged = new Map(both.permissions?.map((g) => [g.permission, g.scope]));
    expect(merged.get('verification.read')).toBe('all');
    expect(merged.get('verification.review')).toBe('all');
  });

  it('sends only permission and scope, drops rows this build does not know, and nothing for an inactive user', async () => {
    const rows: Row[] = [
      { roleKey: 'sales', permission: 'customer.read', scope: 'all' },
      { roleKey: 'sales', permission: 'made.up.permission', scope: 'all' },
      { roleKey: 'sales', permission: 'customer.write', scope: 'galaxy' },
    ];
    const grants = await cacheOver(rows).grantsFor(TENANT, ENTITY, ['sales']);
    const body = meAs(principalOf(['sales'], grants));

    expect(Object.keys(body).sort()).toEqual(
      [
        'correlationId',
        'orgKind',
        'organizationId',
        'partyId',
        'permissions',
        'roles',
        'tenantId',
        'userId',
      ].sort(),
    );
    expect(body.permissions).toEqual([{ permission: 'customer.read', scope: 'all' }]);
    for (const grant of body.permissions ?? []) {
      expect(Object.keys(grant).sort()).toEqual(['permission', 'scope']);
    }
    // The ZITADEL sub is the public user id; the app uuid, department and status stay internal.
    expect(body.userId).toBe(SUB);
    const text = JSON.stringify(body);
    expect(text).not.toContain(APP_USER);
    expect(text).not.toContain(DEPARTMENT);
    expect(text).not.toContain(IDP_ORG);
    expect(body).not.toHaveProperty('status');
    expect(body).not.toHaveProperty('zitadelUserId');

    const invited = meAs(principalOf(['sales'], grants, 'invited'));
    expect(invited.permissions).toEqual([]);
  });
});
