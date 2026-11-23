// Integration tests of the customer's account owner (R4c2 Q5a + Q6b): changing `ownerUserId` on PATCH
// /v1/customers/:id, or naming another owner on create, needs `customers.owner.write`; the owner must be an active
// staff user of the tenant; a change is audited. Real: every migration, queries as bos_app, the controller behind
// the production body parser and error filter, CustomersService, withTx, the customers audit trigger and
// audit.record(). Faked: the request context and authz.assert, which run the real pure can() on a fake principal
// holding a role's DEFAULT grants.
// Run: pnpm --filter @bos/api exec vitest run src/modules/customers/customers-owner.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CustomerDtoSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  customers,
  users,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { can } from '../../platform/authz/can';
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
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
const now = new Date('2026-11-21T04:00:00Z');

type Tenant = { tenantId: string; organizationId: string; idpOrgId: string; userId: string };
let a: Tenant;
let b: Tenant;
type Role = 'founder' | 'management' | 'sales' | 'accountant';
const usersA = {} as Record<Role, string>;
/** Candidate owners in tenant A: an active Sales colleague, a disabled one, an invited one and a portal user. */
let colleague: string;
let disabled: string;
let invited: string;
let portalUser: string;

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
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code });
    const { userId } = await createStaffUser(appPool, { ...t, roleKeys: ['founder'] });
    return { ...t, userId };
  };
  a = await tenant('OA');
  b = await tenant('OB');
  for (const role of ['founder', 'management', 'sales', 'accountant'] as const) {
    usersA[role] = (await createStaffUser(appPool, { ...a, roleKeys: [role] })).userId;
  }
  colleague = (await createStaffUser(appPool, { ...a, roleKeys: ['sales'] })).userId;
  disabled = (await createStaffUser(appPool, { ...a, roleKeys: ['sales'] })).userId;
  invited = (await createStaffUser(appPool, { ...a, roleKeys: ['sales'] })).userId;
  await withTx(db, a, systemActor('test'), async (tx) => {
    await tx.update(users).set({ status: 'inactive' }).where(eq(users.id, disabled));
    await tx.update(users).set({ status: 'invited' }).where(eq(users.id, invited));
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
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => as('founder'));

// ---------------------------------------------------------------------------------------------- helpers

const address = { line: 'Ring Road', city: 'Kathmandu' };
let keySeq = 0;
const post = (body: Record<string, unknown>) =>
  request(baseUrl)
    .post('/v1/customers')
    .set('Idempotency-Key', `owner-key-${++keySeq}`)
    .send({
      legalName: `Owner Customer ${randomUUID().slice(0, 8)} Pvt. Ltd.`,
      country: 'NP',
      address,
      contact: {
        fullName: 'First Contact',
        email: `o-${randomUUID().slice(0, 8)}@example.com`,
        country: 'NP',
      },
      ...body,
    });

/** A customer of `tenant` owned by its Founder-role creator (the default owner), then the caller is put back. */
async function createCustomer(tenant: Tenant = a) {
  const saved = { ...current };
  as('founder', tenant);
  const res = await post({});
  Object.assign(current, saved);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CustomerDtoSchema.parse(res.body);
}

const patch = (id: string, body: Record<string, unknown>) =>
  request(baseUrl).patch(`/v1/customers/${id}`).send(body);

const storedOwner = async (id: string) => {
  const [row] = await db
    .select({ ownerUserId: customers.ownerUserId, version: customers.version })
    .from(customers)
    .where(eq(customers.id, id));
  return row;
};

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

// ---------------------------------------------------------------------------------------------- tests

describe('changing the owner on PATCH /v1/customers/:id', () => {
  it('refuses Sales (customer.write only) with 403 and keeps the owner', async () => {
    const customer = await createCustomer();
    as('sales');
    const res = await patch(customer.id, { expectedVersion: 1, ownerUserId: colleague });
    expect(res.status).toBe(403);
    expect(errorOf(res.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
    expect(await storedOwner(customer.id)).toEqual({ ownerUserId: usersA.founder, version: 1 });
  });

  it.each(['management', 'founder'] as const)(
    'lets %s change it, and audits who did it',
    async (role) => {
      const customer = await createCustomer();
      as(role);
      const res = await patch(customer.id, { expectedVersion: 1, ownerUserId: colleague });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(CustomerDtoSchema.parse(res.body)).toMatchObject({
        ownerUserId: colleague,
        version: 2,
      });

      const { rows } = await ownerPool.query<{
        action: string;
        actor_id: string;
        before: unknown;
        after: unknown;
      }>(
        `SELECT action, actor_id, before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'customers' AND entity_id = $2 AND action = 'customer.owner_changed'`,
        [a.tenantId, customer.id],
      );
      expect(rows).toEqual([
        {
          action: 'customer.owner_changed',
          actor_id: usersA[role],
          before: { ownerUserId: usersA.founder },
          after: { ownerUserId: colleague },
        },
      ]);
      // The row change itself is audited by the trigger, under the same actor.
      const trigger = await ownerPool.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'customers' AND entity_id = $2 AND action = 'customers.update'`,
        [a.tenantId, customer.id],
      );
      expect(trigger.rows.map((r) => r.actor_id)).toEqual([usersA[role]]);
    },
  );

  it('refuses Management any other field (no customer.write), even alongside an allowed owner change', async () => {
    const customer = await createCustomer();
    as('management');
    expect((await patch(customer.id, { expectedVersion: 1, industry: 'Retail' })).status).toBe(403);
    expect(
      (await patch(customer.id, { expectedVersion: 1, industry: 'Retail', ownerUserId: colleague }))
        .status,
    ).toBe(403);
    expect(await storedOwner(customer.id)).toEqual({ ownerUserId: usersA.founder, version: 1 });
  });

  it('does not count the stored owner sent again as a change (Sales may save the rest of the form)', async () => {
    const customer = await createCustomer();
    as('sales');
    const res = await patch(customer.id, {
      expectedVersion: 1,
      ownerUserId: usersA.founder,
      industry: 'Retail',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const { rows } = await ownerPool.query(
      `SELECT 1 FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'customer.owner_changed'`,
      [a.tenantId, customer.id],
    );
    expect(rows).toEqual([]);
  });

  it('accepts the stored owner alone from either grant, and from neither refuses it before any lookup', async () => {
    const customer = await createCustomer();
    // The founder created it, so sending the founder again repeats the stored owner: nothing is written and the
    // version stays 1 (R6AE: a PATCH that repeats the stored values keeps the version).
    as('management');
    expect(
      (await patch(customer.id, { expectedVersion: 1, ownerUserId: usersA.founder })).status,
    ).toBe(200);
    as('sales');
    expect(
      (await patch(customer.id, { expectedVersion: 1, ownerUserId: usersA.founder })).status,
    ).toBe(200);
    expect((await storedOwner(customer.id))?.version).toBe(1);
    as('accountant');
    expect((await patch(customer.id, { expectedVersion: 1, ownerUserId: colleague })).status).toBe(
      403,
    );
    expect((await patch(randomUUID(), { expectedVersion: 1, ownerUserId: colleague })).status).toBe(
      403,
    );
  });

  it("is 404 for another tenant's customer, and 409 on a stale version", async () => {
    const theirs = await createCustomer(b);
    as('management');
    expect((await patch(theirs.id, { expectedVersion: 1, ownerUserId: colleague })).status).toBe(
      404,
    );
    const mine = await createCustomer();
    expect((await patch(mine.id, { expectedVersion: 7, ownerUserId: colleague })).status).toBe(409);
  });
});

describe('who can be the owner', () => {
  it.each([
    ['a disabled staff user', () => disabled],
    ['a portal user', () => portalUser],
    ["another tenant's user", () => b.userId],
    ['an unknown id', () => randomUUID()],
  ])('refuses %s with 400 not_active_staff', async (_label, who) => {
    const customer = await createCustomer();
    as('management');
    const res = await patch(customer.id, { expectedVersion: 1, ownerUserId: who() });
    expect(res.status).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'bad_request',
      details: { assignmentReason: 'not_active_staff' },
    });
    expect(await storedOwner(customer.id)).toEqual({ ownerUserId: usersA.founder, version: 1 });
  });

  it('accepts an invited staff user (sign-up not finished), as before', async () => {
    const customer = await createCustomer();
    as('management');
    expect((await patch(customer.id, { expectedVersion: 1, ownerUserId: invited })).status).toBe(
      200,
    );
  });

  it('does not block other edits when the stored owner was disabled later', async () => {
    const customer = await createCustomer();
    as('management');
    expect((await patch(customer.id, { expectedVersion: 1, ownerUserId: disabled })).status).toBe(
      400,
    );
    // Make the disabled user the owner behind the API's back (an older row), then edit the rest of the form.
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.update(customers).set({ ownerUserId: disabled }).where(eq(customers.id, customer.id)),
    );
    as('sales');
    const res = await patch(customer.id, {
      expectedVersion: 1,
      ownerUserId: disabled,
      industry: 'Mining',
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});

describe('the owner on create', () => {
  it('defaults to the creator, and lets Sales name themselves', async () => {
    as('sales');
    const plain = await post({});
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(CustomerDtoSchema.parse(plain.body).ownerUserId).toBe(usersA.sales);
    const self = await post({ ownerUserId: usersA.sales });
    expect(self.status).toBe(201);
  });

  it('refuses Sales naming someone else (403), and creates nothing', async () => {
    as('sales');
    const legalName = `Refused ${randomUUID().slice(0, 8)} Pvt. Ltd.`;
    const res = await post({ legalName, ownerUserId: colleague });
    expect(res.status).toBe(403);
    const rows = await db.select().from(customers).where(eq(customers.legalName, legalName));
    expect(rows).toEqual([]);
  });

  it('lets the Founder name an active colleague, but not a disabled or portal user', async () => {
    const ok = await post({ ownerUserId: colleague });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(CustomerDtoSchema.parse(ok.body).ownerUserId).toBe(colleague);
    expect((await post({ ownerUserId: disabled })).status).toBe(400);
    expect((await post({ ownerUserId: portalUser })).status).toBe(400);
  });
});
