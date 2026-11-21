// Integration tests of PATCH /v1/customers/:id/terms (R4a Q12: the credit limit is set in the app by an authorised
// role, audited) on a real Postgres. Real: every migration, queries as bos_app, the controller behind the production
// body parser and error filter, CustomersService, withTx, the party_accounts audit trigger and audit.record().
// Faked: the request context (CustomersCaller) and authz.assert, which still runs the real pure can() on a fake
// principal holding a role's DEFAULT grants, so each 403 or 200 is the decision the role gets in production.
// Run: pnpm --filter @bos/api exec vitest run src/modules/customers/customers-terms.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  CustomerDtoSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  PartyAccountDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createStaffUser,
  createTenantWithEntity,
  customers,
  organizations,
  partyAccounts,
  paymentTerms,
  scoped,
  userEntities,
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
/** Tenant A: default entity plus `entityA2`; tenant B: default only. */
let a: Tenant;
let b: Tenant;
let entityA2: string;
/** One user per role in tenant A, each a member of both of A's entities (so GET lists both terms rows). */
const usersA = {} as Record<'founder' | 'finance' | 'management' | 'sales' | 'accountant', string>;
/** Payment terms: two active ones of A, a switched-off one of A, and an active one of B. */
let net30: string;
let net60: string;
let inactiveTerm: string;
let termOfB: string;

const current: {
  tenant: Tenant;
  organizationId: string;
  userId: string;
  grants: Map<Permission, Scope>;
  orgKind: Principal['orgKind'];
  roles: RoleKey[];
} = {
  tenant: undefined as never,
  organizationId: '',
  userId: '',
  grants: new Map(),
  orgKind: 'staff',
  roles: [],
};
const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** Act as `role` in tenant A (or `tenant`), for `organizationId`, as that role's own user. */
const as = (
  role: keyof typeof usersA,
  organizationId = a.organizationId,
  tenant: Tenant = a,
  userId = tenant === a ? usersA[role] : tenant.userId,
) => {
  current.tenant = tenant;
  current.organizationId = organizationId;
  current.userId = userId;
  current.grants = grantsOf(role);
  current.orgKind = 'staff';
  current.roles = [role];
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  tenantId: current.tenant.tenantId,
  organizationId: current.organizationId,
  orgKind: current.orgKind,
  partyId: current.orgKind === 'staff' ? null : randomUUID(),
  idpOrgId: current.tenant.idpOrgId,
  roles: current.roles,
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: { tenantId: current.tenant.tenantId, organizationId: current.organizationId },
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

const addTerm = async (t: Tenant, code: string, netDays: number, isActive = true) => {
  const [row] = await withTx(db, t, systemActor('test'), (tx) =>
    tx
      .insert(paymentTerms)
      .values({ tenantId: t.tenantId, code, name: `Net ${netDays}`, netDays, isActive })
      .returning({ id: paymentTerms.id }),
  );
  return row!.id;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code, name: `Entity ${code}` });
    const { userId } = await createStaffUser(appPool, { ...t });
    return { ...t, userId };
  };
  a = await tenant('TA');
  b = await tenant('TB');
  entityA2 = randomUUID();
  await withTx(db, a, systemActor('test'), (tx) =>
    tx.insert(organizations).values({
      id: entityA2,
      tenantId: a.tenantId,
      organizationId: entityA2,
      code: 'TA2',
      name: 'Second entity',
      legalName: 'Second entity',
    }),
  );
  for (const role of ['founder', 'finance', 'management', 'sales', 'accountant'] as const) {
    const { userId } = await createStaffUser(appPool, { ...a, roleKeys: [role] });
    usersA[role] = userId;
    await withTx(
      db,
      { tenantId: a.tenantId, organizationId: entityA2 },
      systemActor('test'),
      (tx) =>
        tx.insert(userEntities).values({
          tenantId: a.tenantId,
          organizationId: entityA2,
          userId,
          isDefault: false,
        }),
    );
  }
  net30 = await addTerm(a, 'NET30', 30);
  net60 = await addTerm(a, 'NET60', 60);
  inactiveTerm = await addTerm(a, 'OLD90', 90, false);
  termOfB = await addTerm(b, 'NET45', 45);

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

const address = { line1: 'Ring Road', city: 'Kathmandu', country: 'NP' };

let keySeq = 0;
/** A new customer of `tenant`, created by its Founder (customer.write), then the caller is put back. */
async function createCustomer(tenant: Tenant = a) {
  const saved = { ...current, grants: current.grants };
  current.tenant = tenant;
  current.organizationId = tenant.organizationId;
  current.userId = tenant === a ? usersA.founder : tenant.userId;
  current.grants = grantsOf('founder');
  const res = await request(baseUrl)
    .post('/v1/customers')
    .set('Idempotency-Key', `terms-key-${++keySeq}`)
    .send({
      legalName: `Terms Customer ${randomUUID().slice(0, 8)} Pvt. Ltd.`,
      address,
      contact: { fullName: 'First Contact', email: `t-${randomUUID().slice(0, 8)}@example.com` },
    });
  Object.assign(current, saved);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CustomerDtoSchema.parse(res.body);
}

/** A terms save as the workspace sends it: the form names the acting entity it was rendered for. */
const putTerms = (id: string, body: object) =>
  putRaw(id, { organizationId: current.organizationId, ...body });
/** A terms save sent exactly as given (no entity added). */
const putRaw = (id: string, body: object) =>
  request(baseUrl).patch(`/v1/customers/${id}/terms`).send(body);

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

/** The stored row of `partyId` with `organizationId`, read as the owner role (not through the API). */
async function storedRow(partyId: string, organizationId: string, tenant: Tenant = a) {
  const { rows } = await ownerPool.query<{
    credit_limit: string | null;
    payment_term_id: string | null;
    version: number;
  }>(
    `SELECT credit_limit, payment_term_id, version FROM app.party_accounts
      WHERE tenant_id = $1 AND organization_id = $2 AND party_id = $3`,
    [tenant.tenantId, organizationId, partyId],
  );
  return rows;
}

type Detail = {
  accounts?: unknown[];
  actingEntity?: { organizationId: string; name: string };
  can?: Record<string, boolean>;
};
async function detail(id: string) {
  const res = await request(baseUrl).get(`/v1/customers/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return res.body as Detail;
}

// ---------------------------------------------------------------------------------------------- tests

describe('who may set the credit limit (customers.credit_limit.write)', () => {
  it.each(['founder', 'finance'] as const)(
    '%s sets it: 200 and the row is written',
    async (role) => {
      const customer = await createCustomer();
      as(role);
      const res = await putTerms(customer.id, { creditLimit: '250000' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(PartyAccountDtoSchema.parse(res.body)).toEqual({
        partyId: customer.id,
        organizationId: a.organizationId,
        organizationName: 'Entity TA',
        paymentTermId: null,
        creditLimit: '250000.00',
        version: 1,
      });
      expect(await storedRow(customer.id, a.organizationId)).toEqual([
        { credit_limit: '250000.00', payment_term_id: null, version: 1 },
      ]);
    },
  );

  it.each(['management', 'sales', 'accountant'] as const)(
    '%s is refused with 403 and nothing is written',
    async (role) => {
      const customer = await createCustomer();
      as(role);
      const res = await putTerms(customer.id, { creditLimit: '1000.00' });
      expect(res.status).toBe(403);
      expect(errorOf(res.body)).toMatchObject({ code: 'forbidden', reason: 'no_permission' });
      expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
    },
  );

  it('refuses the whole save (403) when a Sales user sends a limit with a term, rather than dropping the limit', async () => {
    const customer = await createCustomer();
    as('sales');
    const res = await putTerms(customer.id, { paymentTermId: net30, creditLimit: '5000.00' });
    expect(res.status).toBe(403);
    expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
  });
});

describe('who may set the payment term (customer.write)', () => {
  it.each(['founder', 'sales'] as const)('%s sets it', async (role) => {
    const customer = await createCustomer();
    as(role);
    const res = await putTerms(customer.id, { paymentTermId: net30 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartyAccountDtoSchema.parse(res.body)).toMatchObject({
      paymentTermId: net30,
      creditLimit: null,
      version: 1,
    });
  });

  it.each(['finance', 'management'] as const)(
    '%s (no customer.write) is refused with 403',
    async (role) => {
      const customer = await createCustomer();
      as(role);
      const res = await putTerms(customer.id, { paymentTermId: net30 });
      expect(res.status).toBe(403);
      expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
    },
  );

  it('refuses a caller holding neither permission before looking the customer up (403, even for an unknown id)', async () => {
    as('accountant');
    expect((await putTerms(randomUUID(), { paymentTermId: net30 })).status).toBe(403);
    as('management');
    expect((await putTerms(randomUUID(), { creditLimit: '1.00' })).status).toBe(403);
  });

  it('refuses a portal caller (staff only)', async () => {
    const customer = await createCustomer();
    as('founder');
    current.orgKind = 'customer';
    expect((await putTerms(customer.id, { creditLimit: '1.00' })).status).toBe(403);
  });
});

describe('the payment term must be an active term of the tenant', () => {
  it('rejects an unknown, a switched-off and another tenant’s term with 422 naming the field', async () => {
    const customer = await createCustomer();
    for (const [termId, message] of [
      [randomUUID(), 'This payment term does not exist'],
      [termOfB, 'This payment term does not exist'],
      [inactiveTerm, 'This payment term is switched off; choose an active one'],
    ] as const) {
      const res = await putTerms(customer.id, { paymentTermId: termId });
      expect(res.status, termId).toBe(422);
      expect(errorOf(res.body)).toMatchObject({ code: 'unprocessable', message });
      expect((res.body as { error: { fieldErrors?: unknown } }).error.fieldErrors).toEqual({
        paymentTermId: message,
      });
    }
    expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
  });

  it('clears the term with null, and keeps an unchanged term that was switched off later', async () => {
    const customer = await createCustomer();
    const temp = await addTerm(a, `TMP${randomUUID().slice(0, 6)}`, 10);
    expect((await putTerms(customer.id, { paymentTermId: temp })).status).toBe(200);
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.update(paymentTerms).set({ isActive: false }).where(eq(paymentTerms.id, temp)),
    );
    // Saving the limit with the same (now switched-off) term is not a change of term.
    const same = await putTerms(customer.id, {
      paymentTermId: temp,
      creditLimit: '10.00',
      expectedVersion: 1,
    });
    expect(same.status, JSON.stringify(same.body)).toBe(200);
    const cleared = await putTerms(customer.id, { paymentTermId: null, expectedVersion: 2 });
    expect(cleared.status).toBe(200);
    expect(PartyAccountDtoSchema.parse(cleared.body)).toMatchObject({
      paymentTermId: null,
      creditLimit: '10.00',
      version: 3,
    });
  });
});

describe('the record, the tenant and the version', () => {
  it('is 404 for a customer of another tenant and for an unknown id, and writes nothing', async () => {
    const theirs = await createCustomer(b);
    as('founder');
    expect((await putTerms(theirs.id, { creditLimit: '1.00' })).status).toBe(404);
    expect((await putTerms(randomUUID(), { creditLimit: '1.00' })).status).toBe(404);
    expect(await storedRow(theirs.id, a.organizationId, b)).toEqual([]);
    expect(await storedRow(theirs.id, b.organizationId, b)).toEqual([]);
  });

  it('is 404 for a customer merged into another, and writes no terms row; the surviving customer takes them', async () => {
    const survivor = await createCustomer();
    const merged = await createCustomer();
    // No merge route exists yet, so the merge is set on the row as a merge would leave it.
    await withTx(db, a, systemActor('test'), (tx) =>
      tx
        .update(customers)
        .set({ mergedIntoId: survivor.id })
        .where(and(eq(customers.tenantId, a.tenantId), eq(customers.id, merged.id))),
    );
    as('founder');
    for (const body of [{ creditLimit: '1000.00' }, { paymentTermId: net30 }]) {
      const res = await putTerms(merged.id, body);
      expect(res.status, JSON.stringify(res.body)).toBe(404);
      expect(errorOf(res.body).code).toBe('not_found');
    }
    expect(await storedRow(merged.id, a.organizationId)).toEqual([]);
    // The control: the same save on the customer it was merged into goes through.
    expect((await putTerms(survivor.id, { creditLimit: '1000.00' })).status).toBe(200);
    expect(await storedRow(survivor.id, a.organizationId)).toHaveLength(1);
  });

  it('is 409 for a stale version, a missing version once the row exists, and a version before the row exists', async () => {
    const customer = await createCustomer();
    expect((await putTerms(customer.id, { creditLimit: '1.00', expectedVersion: 1 })).status).toBe(
      409,
    );
    expect((await putTerms(customer.id, { creditLimit: '100.00' })).status).toBe(200);
    expect((await putTerms(customer.id, { creditLimit: '200.00' })).status).toBe(409);
    expect(
      (await putTerms(customer.id, { creditLimit: '200.00', expectedVersion: 2 })).status,
    ).toBe(409);
    const ok = await putTerms(customer.id, { creditLimit: '200.00', expectedVersion: 1 });
    expect(ok.status).toBe(200);
    expect(PartyAccountDtoSchema.parse(ok.body).version).toBe(2);
    expect(await storedRow(customer.id, a.organizationId)).toEqual([
      { credit_limit: '200.00', payment_term_id: null, version: 2 },
    ]);
  });

  it('lets exactly one of two first saves win (the unique index), the other is 409', async () => {
    const customer = await createCustomer();
    const [r1, r2] = await Promise.all([
      putTerms(customer.id, { creditLimit: '1.00' }),
      putTerms(customer.id, { creditLimit: '2.00' }),
    ]);
    expect([r1.status, r2.status].sort()).toEqual([200, 409]);
    expect(await storedRow(customer.id, a.organizationId)).toHaveLength(1);
  });
});

describe('the amount', () => {
  it('keeps no limit (null) apart from a zero limit ("0.00")', async () => {
    const customer = await createCustomer();
    const zero = await putTerms(customer.id, { creditLimit: '0' });
    expect(PartyAccountDtoSchema.parse(zero.body).creditLimit).toBe('0.00');
    expect((await storedRow(customer.id, a.organizationId))[0]?.credit_limit).toBe('0.00');
    const none = await putTerms(customer.id, { creditLimit: null, expectedVersion: 1 });
    expect(PartyAccountDtoSchema.parse(none.body).creditLimit).toBeNull();
    expect((await storedRow(customer.id, a.organizationId))[0]?.credit_limit).toBeNull();
  });

  it.each(['1.005', '-1.00', '1e3', 'ten', 1000])('rejects %s with 400', async (creditLimit) => {
    const customer = await createCustomer();
    expect((await putTerms(customer.id, { creditLimit })).status).toBe(400);
    expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
  });

  it('rejects an empty body and an unknown key with 400', async () => {
    const customer = await createCustomer();
    expect((await putTerms(customer.id, {})).status).toBe(400);
    expect((await putTerms(customer.id, { expectedVersion: 1 })).status).toBe(400);
    expect(
      (await putTerms(customer.id, { creditLimit: '1.00', ownerUserId: a.userId })).status,
    ).toBe(400);
  });
});

describe('entity isolation (row security is off for party_accounts)', () => {
  it("writes only the acting entity's row: a save for entity A2 leaves the default entity's row alone", async () => {
    const customer = await createCustomer();
    as('finance', a.organizationId);
    expect((await putTerms(customer.id, { creditLimit: '1000.00' })).status).toBe(200);
    as('finance', entityA2);
    // The A2 row does not exist yet, so no version: this is a first save, not an edit of the default entity's row.
    const second = await putTerms(customer.id, { creditLimit: '5.00' });
    expect(second.status, JSON.stringify(second.body)).toBe(200);
    expect(PartyAccountDtoSchema.parse(second.body)).toMatchObject({
      organizationId: entityA2,
      organizationName: 'Second entity',
      creditLimit: '5.00',
      version: 1,
    });
    // Editing A2 with the default row's version touches A2 only.
    expect((await putTerms(customer.id, { creditLimit: '6.00', expectedVersion: 1 })).status).toBe(
      200,
    );
    expect(await storedRow(customer.id, a.organizationId)).toEqual([
      { credit_limit: '1000.00', payment_term_id: null, version: 1 },
    ]);
    expect(await storedRow(customer.id, entityA2)).toEqual([
      { credit_limit: '6.00', payment_term_id: null, version: 2 },
    ]);
  });
});

describe('the entity the form was rendered for (organizationId)', () => {
  it("is 409 entity_changed for another entity's id and leaves both entities' rows untouched", async () => {
    const customer = await createCustomer();
    as('founder', a.organizationId);
    expect(
      (await putTerms(customer.id, { creditLimit: '1000.00', paymentTermId: net30 })).status,
    ).toBe(200);
    as('founder', entityA2);
    expect((await putTerms(customer.id, { creditLimit: '5.00' })).status).toBe(200);
    // The form was rendered for A2; the caller has since switched to the default entity in another tab.
    as('founder', a.organizationId);
    for (const body of [
      { creditLimit: '9.00', expectedVersion: 1 },
      { paymentTermId: net60, expectedVersion: 1 },
      { creditLimit: null },
    ]) {
      const res = await putRaw(customer.id, { organizationId: entityA2, ...body });
      expect(res.status, JSON.stringify(res.body)).toBe(409);
      expect(errorOf(res.body)).toMatchObject({
        code: 'conflict',
        reason: 'entity_changed',
        message: 'You switched legal entity since this page loaded; reload and try again',
      });
    }
    expect(await storedRow(customer.id, a.organizationId)).toEqual([
      { credit_limit: '1000.00', payment_term_id: net30, version: 1 },
    ]);
    expect(await storedRow(customer.id, entityA2)).toEqual([
      { credit_limit: '5.00', payment_term_id: null, version: 1 },
    ]);
    const { rows } = await ownerPool.query(
      `SELECT 1 FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'customer.terms_changed'`,
      [a.tenantId, customer.id],
    );
    expect(rows).toHaveLength(2);
  });

  it('is 409 for a first save named for another entity, and writes no row', async () => {
    const customer = await createCustomer();
    as('finance', a.organizationId);
    const res = await putRaw(customer.id, { organizationId: entityA2, creditLimit: '1.00' });
    expect(res.status).toBe(409);
    expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
    expect(await storedRow(customer.id, entityA2)).toEqual([]);
  });

  it('saves when the id is the acting entity', async () => {
    const customer = await createCustomer();
    as('finance', entityA2);
    const res = await putRaw(customer.id, { organizationId: entityA2, creditLimit: '42.00' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(PartyAccountDtoSchema.parse(res.body)).toMatchObject({
      organizationId: entityA2,
      creditLimit: '42.00',
      version: 1,
    });
  });

  it('is 400 without the id or with a non-uuid id, and writes nothing', async () => {
    const customer = await createCustomer();
    expect((await putRaw(customer.id, { creditLimit: '1.00' })).status).toBe(400);
    expect((await putRaw(customer.id, { organizationId: 'TA', creditLimit: '1.00' })).status).toBe(
      400,
    );
    expect(await storedRow(customer.id, a.organizationId)).toEqual([]);
  });
});

describe('audit', () => {
  it('records the row change (trigger) and customer.terms_changed with before, after and the actor', async () => {
    const customer = await createCustomer();
    as('finance');
    expect((await putTerms(customer.id, { creditLimit: '700.00' })).status).toBe(200);
    as('founder');
    expect(
      (await putTerms(customer.id, { paymentTermId: net60, creditLimit: null, expectedVersion: 1 }))
        .status,
    ).toBe(200);
    const [row] = await db
      .select({ id: partyAccounts.id })
      .from(partyAccounts)
      .where(
        and(
          eq(partyAccounts.partyId, customer.id),
          eq(partyAccounts.organizationId, a.organizationId),
        ),
      );
    const { rows } = await ownerPool.query<{
      action: string;
      entity_type: string;
      entity_id: string;
      actor_id: string;
      organization_id: string;
      before: unknown;
      after: unknown;
      meta: Record<string, unknown> | null;
    }>(
      `SELECT action, entity_type, entity_id, actor_id, organization_id, before, after, meta
         FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id IN ($2, $3)
        ORDER BY id`,
      [a.tenantId, customer.id, row!.id],
    );
    const trigger = rows.filter((r) => r.entity_type === 'party_accounts');
    expect(trigger.map((r) => r.actor_id)).toEqual([usersA.finance, usersA.founder]);
    const events = rows.filter((r) => r.action === 'customer.terms_changed');
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      entity_type: 'customers',
      entity_id: customer.id,
      actor_id: usersA.finance,
      organization_id: a.organizationId,
      before: { paymentTermId: null, creditLimit: null },
      after: { paymentTermId: null, creditLimit: '700.00' },
    });
    expect(events[0]!.meta).toMatchObject({ fields: ['creditLimit'], partyAccountId: row!.id });
    expect(events[1]).toMatchObject({
      actor_id: usersA.founder,
      before: { paymentTermId: null, creditLimit: '700.00' },
      after: { paymentTermId: net60, creditLimit: null },
    });
    expect(events[1]!.meta).toMatchObject({ fields: ['paymentTermId', 'creditLimit'] });
  });

  it('records nothing for a refused save', async () => {
    const customer = await createCustomer();
    as('sales');
    expect((await putTerms(customer.id, { creditLimit: '1.00' })).status).toBe(403);
    const { rows } = await ownerPool.query(
      `SELECT 1 FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 AND action = 'customer.terms_changed'`,
      [a.tenantId, customer.id],
    );
    expect(rows).toEqual([]);
  });
});

describe('the detail read: actingEntity and the terms flags', () => {
  it.each([
    ['founder', { creditLimit: true, owner: true, paymentTerms: true, write: true }],
    ['finance', { creditLimit: true, owner: false, paymentTerms: false, write: false }],
    ['management', { creditLimit: false, owner: true, paymentTerms: false, write: false }],
    ['sales', { creditLimit: false, owner: false, paymentTerms: true, write: true }],
  ] as const)(
    'gives %s its flags and names the acting entity, with no terms row yet',
    async (role, flags) => {
      const customer = await createCustomer();
      as(role, entityA2);
      const body = await detail(customer.id);
      expect(body.can).toMatchObject(flags);
      expect(body.actingEntity).toEqual({ organizationId: entityA2, name: 'Second entity' });
      expect(body.accounts).toEqual([]);
    },
  );
});

describe('end to end: what the endpoint writes is what the readers read', () => {
  it('a limit set by Finance reads back through GET /v1/customers/:id as the same actor', async () => {
    const customer = await createCustomer();
    as('finance', entityA2);
    const saved = PartyAccountDtoSchema.parse(
      (await putTerms(customer.id, { creditLimit: '123456.70' })).body,
    );
    const body = await detail(customer.id);
    expect(body.accounts?.map((x) => PartyAccountDtoSchema.parse(x))).toEqual([saved]);
    expect(saved).toMatchObject({ organizationId: entityA2, creditLimit: '123456.70' });
  });

  it("a payment term set through the endpoint is the one invoice issue's due-date query finds for that entity only", async () => {
    // The query of InvoiceIssueService.dueDateOf (debit notes), verbatim: party_accounts of the acting entity,
    // joined to payment_terms. Not the issue path itself (that needs an approved debit note; see the report).
    const netDaysFor = (organizationId: string, partyId: string) =>
      withTx(db, { tenantId: a.tenantId, organizationId }, systemActor('test'), async (tx) => {
        const scope = { tenantId: a.tenantId, organizationId };
        const [term] = await tx
          .select({ netDays: paymentTerms.netDays })
          .from(partyAccounts)
          .innerJoin(
            paymentTerms,
            and(
              eq(paymentTerms.tenantId, partyAccounts.tenantId),
              eq(paymentTerms.id, partyAccounts.paymentTermId),
            ),
          )
          .where(scoped(scope).where(partyAccounts, eq(partyAccounts.partyId, partyId)))
          .limit(1);
        return term?.netDays;
      });
    const customer = await createCustomer();
    as('sales', entityA2);
    expect((await putTerms(customer.id, { paymentTermId: net60 })).status).toBe(200);
    expect(await netDaysFor(entityA2, customer.id)).toBe(60);
    expect(await netDaysFor(a.organizationId, customer.id)).toBeUndefined();
  });
});

describe('the terms of an entity are read by the roles of the membership there (R5 FU4)', () => {
  /**
   * Finance in the default entity A, and a membership of the second entity that allows Warehouse only (the user's
   * roles are Finance and Warehouse; `role_keys` of the second membership narrows them to Warehouse, which holds no
   * customer.read).
   */
  async function financeHereWarehouseThere(): Promise<string> {
    const { userId } = await createStaffUser(appPool, {
      ...a,
      roleKeys: ['finance', 'warehouse'],
    });
    await withTx(
      db,
      { tenantId: a.tenantId, organizationId: entityA2 },
      systemActor('test'),
      (tx) =>
        tx.insert(userEntities).values({
          tenantId: a.tenantId,
          organizationId: entityA2,
          userId,
          isDefault: false,
          roleKeys: ['warehouse'],
        }),
    );
    return userId;
  }

  it('hides the credit limit and term of an entity where the membership allows no customer.read', async () => {
    const customer = await createCustomer();
    // Each entity's terms are set by a Finance user acting there.
    as('finance', a.organizationId);
    expect((await putTerms(customer.id, { creditLimit: '111111.00' })).status).toBe(200);
    as('finance', entityA2);
    expect((await putTerms(customer.id, { creditLimit: '222222.00' })).status).toBe(200);

    const mixed = await financeHereWarehouseThere();
    as('finance', a.organizationId, a, mixed);
    const body = await detail(customer.id);
    expect(body.accounts?.map((x) => PartyAccountDtoSchema.parse(x).organizationId)).toEqual([
      a.organizationId,
    ]);
    expect(JSON.stringify(body)).not.toContain('222222');
  });

  it('still shows both entities to a user whose roles there both read customers', async () => {
    const customer = await createCustomer();
    as('finance', a.organizationId);
    await putTerms(customer.id, { creditLimit: '111111.00' });
    as('finance', entityA2);
    await putTerms(customer.id, { creditLimit: '222222.00' });

    as('finance', a.organizationId);
    const body = await detail(customer.id);
    expect(body.accounts?.map((x) => PartyAccountDtoSchema.parse(x).organizationId).sort()).toEqual(
      [a.organizationId, entityA2].sort(),
    );
  });

  it('does not open an entity through a role added after the token was issued', async () => {
    const customer = await createCustomer();
    as('finance', entityA2);
    expect((await putTerms(customer.id, { creditLimit: '222222.00' })).status).toBe(200);
    // The token says Sales; the database has since given the user Finance too, and entity A2 allows Finance only.
    const { userId } = await createStaffUser(appPool, { ...a, roleKeys: ['sales', 'finance'] });
    await withTx(
      db,
      { tenantId: a.tenantId, organizationId: entityA2 },
      systemActor('test'),
      (tx) =>
        tx.insert(userEntities).values({
          tenantId: a.tenantId,
          organizationId: entityA2,
          userId,
          isDefault: false,
          roleKeys: ['finance'],
        }),
    );
    as('sales', a.organizationId, a, userId);
    const body = await detail(customer.id);
    expect(JSON.stringify(body)).not.toContain('222222');
  });
});
