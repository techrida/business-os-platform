// Integration tests of GET /v1/customers/owners: the people the customer card's owner picker offers. Open to
// `customers.owner.write` (Management changes owners without any people directory); active staff users of the
// caller's tenant who hold customer.write (the first portal invite must come from the owner), by name, with no
// address. Also GET /v1/customers/payment-terms, the terms list behind customer.read. Real: every migration, queries as bos_app, the controller behind
// the production body parser and error filter, CustomersService and withTx. Faked: the request context and
// authz.assert, which run the real pure can() on a fake principal holding a role's DEFAULT grants. The route's @Can
// is metadata here (no guard), so the 403s below are the service's own check.
// Run: pnpm --filter @bos/api exec vitest run src/modules/customers/customers-owners-list.integration.test.ts
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CustomerOwnerOptionSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  PaymentTermSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  paymentTerms,
  rolePermissions,
  users,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
import { CAN_KEY } from '../../platform/authz/decorators';
import type { AuthzService } from '../../platform/authz/authz.service';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
const now = new Date('2026-11-21T04:00:00Z');

type Tenant = { tenantId: string; organizationId: string; idpOrgId: string; userId: string };
let a: Tenant;
let b: Tenant;
type Role = 'founder' | 'management' | 'finance' | 'sales' | 'accountant';
const usersA = {} as Record<Role, string>;
/** People in tenant A who must never be offered: a disabled staff user, an invited one and a portal user. */
let disabled: string;
let invited: string;
let portalUser: string;
/** A second staff user of tenant B, so B's list has more than its Founder. */
let otherB: string;

const current: { tenant: Tenant; userId: string; grants: Map<Permission, Scope> } = {
  tenant: undefined as never,
  userId: '',
  grants: new Map(),
};
const as = (role: Role, tenant: Tenant = a) => {
  current.tenant = tenant;
  current.userId = tenant === a ? usersA[role] : tenant.userId;
  current.grants = new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role as RoleKey])) as Map<
    Permission,
    Scope
  >;
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  tenantId: current.tenant.tenantId,
  organizationId: current.tenant.organizationId,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: current.tenant.idpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: { tenantId: current.tenant.tenantId, organizationId: current.tenant.organizationId },
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code });
    const { userId } = await createStaffUser(appPool, { ...t, roleKeys: ['founder'] });
    return { ...t, userId };
  };
  a = await tenant('LA');
  b = await tenant('LB');
  for (const role of ['founder', 'management', 'finance', 'sales', 'accountant'] as const) {
    usersA[role] = (await createStaffUser(appPool, { ...a, roleKeys: [role] })).userId;
  }
  disabled = (await createStaffUser(appPool, { ...a, roleKeys: ['sales'] })).userId;
  invited = (await createStaffUser(appPool, { ...a, roleKeys: ['sales'] })).userId;
  otherB = (await createStaffUser(appPool, { ...b, roleKeys: ['sales'] })).userId;
  await withTx(db, a, systemActor('test'), async (tx) => {
    await tx.update(users).set({ status: 'inactive' }).where(eq(users.id, disabled));
    await tx.update(users).set({ status: 'invited' }).where(eq(users.id, invited));
    // Names that sort differently from creation order, and one person with no name at all.
    await tx.update(users).set({ displayName: 'Zara Founder' }).where(eq(users.id, usersA.founder));
    await tx
      .update(users)
      .set({ displayName: 'Anil Manager' })
      .where(eq(users.id, usersA.management));
    await tx.update(users).set({ displayName: null }).where(eq(users.id, usersA.accountant));
  });
  const party = await createParty(appPool, { tenantId: a.tenantId, kind: 'customer' });
  portalUser = (await createPortalUser(appPool, { tenantId: a.tenantId, idpOrgId: party.idpOrgId }))
    .userId;

  const service = new CustomersService(
    db,
    new NumberingService(),
    authz as unknown as AuthzService,
    caller,
    new AuditService(db),
    () => now,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [CustomersController],
    providers: [{ provide: CustomersService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await testDb?.drop();
});

beforeEach(() => as('management'));

const list = () => request(baseUrl).get('/v1/customers/owners');
const parse = (body: unknown) => CustomerOwnerOptionSchema.array().parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

describe('GET /v1/customers/owners', () => {
  it('gives Management the active staff of its tenant who hold customer.write, by name, with names only', async () => {
    const res = await list();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // Strict: an email, role or any other key added on the server fails here.
    const people = parse(res.body);
    const ids = people.map((p) => p.userId);
    // The first portal invite must come from the owner, so only people who can send it are offered: the Founders
    // and Sales hold customer.write by default; Management, Finance and the Accountant do not.
    expect(new Set(ids)).toEqual(new Set([a.userId, usersA.founder, usersA.sales]));
    for (const left of [usersA.management, usersA.finance, usersA.accountant]) {
      expect(ids).not.toContain(left);
    }
    const names = people.map((p) => p.displayName);
    expect(names).toEqual([...names].sort((x, y) => x.localeCompare(y)));
    expect(people.find((p) => p.userId === usersA.founder)?.displayName).toBe('Zara Founder');
  });

  it('follows the live role rows: a role granted customer.write in Settings > Access is offered at once', async () => {
    const grant = { tenantId: a.tenantId, roleKey: 'finance', permission: 'customer.write' };
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.insert(rolePermissions).values({ ...grant, scope: 'all' }),
    );
    try {
      const withGrant = parse((await list()).body).map((p) => p.userId);
      expect(withGrant).toContain(usersA.finance);
      expect(withGrant).not.toContain(usersA.accountant);
    } finally {
      await withTx(db, a, systemActor('test'), (tx) =>
        tx
          .delete(rolePermissions)
          .where(
            and(
              eq(rolePermissions.tenantId, grant.tenantId),
              eq(rolePermissions.roleKey, grant.roleKey),
              eq(rolePermissions.permission, grant.permission),
            ),
          ),
      );
    }
    expect(parse((await list()).body).map((p) => p.userId)).not.toContain(usersA.finance);
  });

  it('never offers a disabled, invited or portal user, or anyone of another tenant', async () => {
    const ids = parse((await list()).body).map((p) => p.userId);
    for (const excluded of [disabled, invited, portalUser, b.userId, otherB]) {
      expect(ids).not.toContain(excluded);
    }
  });

  it("gives another tenant's Founder only that tenant's people", async () => {
    as('founder', b);
    const res = await list();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(new Set(parse(res.body).map((p) => p.userId))).toEqual(new Set([b.userId, otherB]));
  });

  it.each(['sales', 'finance', 'accountant'] as const)(
    'refuses %s (no customers.owner.write) with 403',
    async (role) => {
      as(role);
      const res = await list();
      expect(res.status).toBe(403);
      expect(errorOf(res.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
    },
  );

  it('names customers.owner.write on the route, for the production guard', () => {
    expect(Reflect.getMetadata(CAN_KEY, CustomersController.prototype.owners)).toBe(
      'customers.owner.write',
    );
  });

  it('lets the Founder read it too', async () => {
    as('founder');
    expect((await list()).status).toBe(200);
  });
});

describe('GET /v1/customers/payment-terms', () => {
  const terms = () => request(baseUrl).get('/v1/customers/payment-terms');
  const asGrants = (...permissions: Permission[]) => {
    current.grants = new Map(permissions.map((p) => [p, 'all']));
  };

  beforeAll(async () => {
    const term = (
      tenantId: string,
      code: string,
      name: string,
      netDays: number,
      isActive = true,
    ) => ({
      tenantId,
      code,
      name,
      netDays,
      isActive,
    });
    await withTx(db, a, systemActor('test'), (tx) =>
      tx
        .insert(paymentTerms)
        .values([
          term(a.tenantId, 'NET30', 'Net 30 days', 30),
          term(a.tenantId, 'NET15', 'Net 15 days', 15),
          term(a.tenantId, 'NET90', 'Net 90 days (retired)', 90, false),
        ]),
    );
    await withTx(db, b, systemActor('test'), (tx) =>
      tx.insert(paymentTerms).values(term(b.tenantId, 'NET45', 'Net 45 days', 45)),
    );
  });

  it("lists the tenant's active terms, shortest first, as id and label only", async () => {
    as('sales');
    const res = await terms();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = PaymentTermSchema.array().parse(res.body);
    expect(body.map((t) => t.label)).toEqual(['Net 15 days', 'Net 30 days']);
  });

  it('serves an editor of customer terms who does not hold quotation.read', async () => {
    asGrants('customer.read', 'customer.write');
    const res = await terms();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PaymentTermSchema.array().parse(res.body)).toHaveLength(2);
  });

  it("never lists another tenant's terms", async () => {
    as('founder', b);
    const labels = PaymentTermSchema.array()
      .parse((await terms()).body)
      .map((t) => t.label);
    expect(labels).toEqual(['Net 45 days']);
  });

  it('refuses a caller without customer.read with 403', async () => {
    asGrants('quotation.read');
    const res = await terms();
    expect(res.status).toBe(403);
    expect(errorOf(res.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
  });

  it('names customer.read on the route, for the production guard', () => {
    expect(Reflect.getMetadata(CAN_KEY, CustomersController.prototype.paymentTerms)).toBe(
      'customer.read',
    );
  });
});
