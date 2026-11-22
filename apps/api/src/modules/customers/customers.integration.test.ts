// Integration tests of the customers API on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: every migration as bos_owner, queries as bos_app, the controller behind the production body parser and
// error filter, CustomersService, NumberingService, withTx and the audit triggers. Faked: the request context
// (CustomersCaller) and authz.assert, which still runs the real pure can() on a fake principal, so the
// ResourceRef the service builds is what decides 403 or 404.
// Run: pnpm --filter @bos/api exec vitest run src/modules/customers
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ContactDtoSchema,
  CustomerDtoSchema,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  PartyAccountDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  checkTenancy,
  createStaffUser,
  createTenantWithEntity,
  customerContacts,
  customers,
  organizations,
  partyAccounts,
  userEntities,
  users,
  verificationCases,
} from '@bos/db';
import { fiscalYearOf } from '@bos/locale';
import { ConflictException, ForbiddenException, type INestApplication } from '@nestjs/common';
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
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { NumberingService } from '../../platform/settings/numbering.service';
import { CustomersController } from './customers.controller';
import { CustomersService } from './customers.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let service: CustomersService;
const now = new Date('2026-11-08T04:00:00Z');

type Tenant = { tenantId: string; organizationId: string; idpOrgId: string; userId: string };
/** Tenant A has a default entity (`a.organizationId`) and a second one (`entityA2`); tenant B has only a default. */
let a: Tenant;
let b: Tenant;
let entityA2: string;

/** The caller: a staff user of one tenant, acting for one of its entities, or a portal user of a customer. */
const current: {
  tenant: Tenant;
  organizationId: string;
  userId: string;
  grants: Map<Permission, Scope>;
  orgKind: Principal['orgKind'];
  partyId: string | null;
} = {
  tenant: undefined as never,
  organizationId: '',
  userId: '',
  grants: new Map(),
  orgKind: 'staff',
  partyId: null,
};
const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const asStaff = (
  tenant: Tenant,
  organizationId = tenant.organizationId,
  userId = tenant.userId,
) => {
  current.tenant = tenant;
  current.organizationId = organizationId;
  current.userId = userId;
  current.grants = grantsOf('sales');
  current.orgKind = 'staff';
  current.partyId = null;
};
/** customer_user has no default grants, so the portal caller gets `customer.read` at `customer_org` here. */
const asPortal = (tenant: Tenant, partyId: string) => {
  asStaff(tenant);
  current.grants = new Map<Permission, Scope>([['customer.read', 'customer_org']]);
  current.orgKind = 'customer';
  current.partyId = partyId;
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  tenantId: current.tenant.tenantId,
  organizationId: current.organizationId,
  orgKind: current.orgKind,
  partyId: current.partyId,
  idpOrgId: current.tenant.idpOrgId,
  roles: ['sales'],
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

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const tenant = async (code: string): Promise<Tenant> => {
    const t = await createTenantWithEntity(appPool, { code });
    const { userId } = await createStaffUser(appPool, { ...t });
    return { ...t, userId };
  };
  a = await tenant('TA');
  b = await tenant('TB');

  // A second legal entity in tenant A, so "numbered from the default entity, audited under the acting one" is
  // observable: the acting entity of most tests is NOT the default one.
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

  service = new CustomersService(
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

beforeEach(() => {
  asStaff(a, entityA2);
});

// ---------------------------------------------------------------------------------------------- helpers

const address = { line1: 'Ring Road', city: 'Kathmandu', country: 'NP' };
/** A customer abroad keeps the loose tax id (letters and hyphens allowed). */
const abroad = { line1: 'MG Road', city: 'Bengaluru', country: 'IN' };
/** Every new customer comes with its first contact, which needs an email. */
const firstContact = () => ({
  fullName: 'First Contact',
  email: `first-${randomUUID().slice(0, 8)}@example.com`,
});
const customerBody = (over: Record<string, unknown> = {}) => ({
  legalName: `Customer ${randomUUID().slice(0, 8)} Pvt. Ltd.`,
  address,
  contact: firstContact(),
  ...over,
});
let keySeq = 0;
const newKey = () => `test-key-${++keySeq}`;

async function createCustomer(over: Record<string, unknown> = {}) {
  const res = await request(baseUrl)
    .post('/v1/customers')
    .set('Idempotency-Key', newKey())
    .send(customerBody(over));
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return CustomerDtoSchema.parse(res.body);
}

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

/** A Nepal PAN: nine digits. */
const panOf = () => String(100_000_000 + Math.floor(Math.random() * 899_999_999));

// ---------------------------------------------------------------------------------------------- tests

describe('schema', () => {
  it('passes check-tenancy for the customer tables', async () => {
    const violations = await checkTenancy(ownerPool);
    expect(violations.filter((v) => v.table.startsWith('app.customer'))).toEqual([]);
  });
});

describe('create a customer and read it back', () => {
  it('creates the party and the customer, numbers from the default entity and audits under the acting one', async () => {
    const body = customerBody({
      legalName: 'Himalayan Construction Pvt. Ltd.',
      panVatNo: 'ab-123456',
      address: abroad,
      industry: 'Construction',
      defaultCurrency: 'NPR',
    });
    const res = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(body);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = CustomerDtoSchema.parse(res.body);
    expect(created).toMatchObject({
      legalName: 'Himalayan Construction Pvt. Ltd.',
      panVatNo: 'AB-123456',
      relationship: 'prospect',
      version: 1,
      mergedIntoId: null,
      logoDocumentId: null,
    });
    // The first number of the tenant's CUS series in this fiscal year.
    expect(created.number).toBe(`CUS-${fiscalYearOf(now)}-00001`);

    const get = await request(baseUrl).get(`/v1/customers/${created.id}`);
    expect(get.status).toBe(200);
    expect(CustomerDtoSchema.parse(get.body)).toEqual(created);
    expect((get.body as { accounts: unknown[] }).accounts).toEqual([]);

    // The party row and the normalised name.
    const party = await ownerPool.query<{ kind: string; name: string; code: string }>(
      'SELECT kind, name, code FROM app.parties WHERE id = $1',
      [created.id],
    );
    expect(party.rows).toEqual([
      { kind: 'customer', name: 'Himalayan Construction Pvt. Ltd.', code: created.number },
    ]);
    const [row] = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(row?.nameNorm).toBe('himalayan construction');

    // The number came from the DEFAULT entity's series, not the acting entity's.
    const series = await ownerPool.query<{ organization_id: string }>(
      `SELECT organization_id FROM app.number_series WHERE tenant_id = $1 AND key = 'CUS'`,
      [a.tenantId],
    );
    expect(series.rows).toEqual([{ organization_id: a.organizationId }]);

    // Every write is audited, and the customer's events carry the ACTING entity (the setting was put back).
    const audited = await ownerPool.query<{
      entity_type: string;
      organization_id: string;
      actor_id: string;
    }>(
      `SELECT entity_type, organization_id, actor_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [a.tenantId, created.id],
    );
    expect(audited.rows.map((r) => r.entity_type).sort()).toEqual(['customers', 'parties']);
    for (const event of audited.rows) {
      expect(event.organization_id).toBe(entityA2);
      expect(event.actor_id).toBe(a.userId);
    }
  });

  it('numbers the next customer 00002, whichever entity acts', async () => {
    asStaff(a);
    const second = await createCustomer();
    expect(second.number).toBe(`CUS-${fiscalYearOf(now)}-00002`);
  });

  it('is visible from every entity of the tenant (tenant-level)', async () => {
    const created = await createCustomer();
    asStaff(a, a.organizationId);
    expect((await request(baseUrl).get(`/v1/customers/${created.id}`)).status).toBe(200);
  });

  it('searches by name (normalised, contains) and by PAN/VAT, and pages with a total', async () => {
    const tag = randomUUID().slice(0, 6);
    const pan = panOf();
    const acme = await createCustomer({ legalName: `Zeta${tag} Traders Pvt. Ltd.`, panVatNo: pan });
    await createCustomer({ legalName: `Other zeta${tag} Company` });
    await createCustomer({ legalName: `Unrelated ${randomUUID()}` });

    // Contains, prefix matches first.
    const contains = await request(baseUrl)
      .get('/v1/customers')
      .query({ q: `zeta${tag}` });
    const found = (contains.body as { items: { legalName: string }[]; total: number }).items.map(
      (c) => c.legalName,
    );
    expect(found).toEqual([`Zeta${tag} Traders Pvt. Ltd.`, `Other zeta${tag} Company`]);

    const byPan = await request(baseUrl).get('/v1/customers').query({ q: pan.toLowerCase() });
    expect((byPan.body as { items: { id: string }[] }).items.map((c) => c.id)).toEqual([acme.id]);

    const page = await request(baseUrl).get('/v1/customers').query({ q: tag, limit: 1, offset: 1 });
    const paged = page.body as { items: unknown[]; total: number };
    expect(paged.items).toHaveLength(1);
    expect(paged.total).toBe(2);

    // No q at all (the workspace's default page) lists the tenant's customers by name.
    const all = await request(baseUrl).get('/v1/customers');
    expect(all.status, JSON.stringify(all.body)).toBe(200);
    expect((all.body as { total: number }).total).toBeGreaterThanOrEqual(3);

    // A LIKE metacharacter is matched literally.
    const percent = await request(baseUrl).get('/v1/customers').query({ q: '%%' });
    expect((percent.body as { items: unknown[] }).items).toEqual([]);
  });

  it('filters by repeated relationship and industry, and counts only the filtered rows', async () => {
    const tag = randomUUID().slice(0, 6);
    const retail = await createCustomer({
      legalName: `Filt${tag} Retail`,
      industry: 'Retail',
      relationship: 'active',
    });
    const mining = await createCustomer({
      legalName: `Filt${tag} Mining`,
      industry: 'Mining',
      relationship: 'prospect',
    });
    await createCustomer({
      legalName: `Filt${tag} Hydro`,
      industry: 'Hydropower',
      relationship: 'inactive',
    });

    const two = await request(baseUrl)
      .get('/v1/customers')
      .query({ q: `Filt${tag}`, relationship: ['active', 'prospect'] });
    const body = two.body as { items: { id: string }[]; total: number };
    expect(two.status).toBe(200);
    expect(body.items.map((c) => c.id).sort()).toEqual([retail.id, mining.id].sort());
    expect(body.total).toBe(2);

    const byIndustry = await request(baseUrl)
      .get('/v1/customers')
      .query({ q: `Filt${tag}`, industry: ['Retail', 'Mining'], relationship: 'active' });
    expect((byIndustry.body as { items: { id: string }[] }).items.map((c) => c.id)).toEqual([
      retail.id,
    ]);

    expect(
      (await request(baseUrl).get('/v1/customers').query({ relationship: 'vip' })).status,
    ).toBe(400);
    const industries = await request(baseUrl).get('/v1/customers/industries');
    expect(industries.status).toBe(200);
    expect(industries.body as string[]).toEqual(expect.arrayContaining(['Retail', 'Mining']));
  });

  it('finds a misspelt name with a typo-tolerant search, and never beyond the tenant or owner scope', async () => {
    const suffix = randomUUID().slice(0, 4);
    const mine = await createCustomer({ legalName: `Himalyan Traders ${suffix} Pvt Ltd` });
    asStaff(b);
    const theirs = await createCustomer({ legalName: `Himalyan Rivals ${suffix} Pvt Ltd` });
    asStaff(a);

    const fuzzy = await request(baseUrl).get('/v1/customers').query({ q: 'Himalayan' });
    const found = (fuzzy.body as { items: { id: string }[] }).items.map((c) => c.id);
    expect(found).toContain(mine.id);
    expect(found).not.toContain(theirs.id);

    // An owner-scoped caller does not see a colleague's customer even when the name is a near match.
    current.grants = new Map<Permission, Scope>([['customer.read', 'own']]);
    current.userId = randomUUID();
    const own = await request(baseUrl).get('/v1/customers').query({ q: 'Himalayan' });
    expect((own.body as { items: unknown[]; total: number }).items).toEqual([]);
    expect((own.body as { total: number }).total).toBe(0);
  });

  it('names the owner on each row of the list, and nothing more of them (U15a-Q3)', async () => {
    const tag = randomUUID().slice(0, 6);
    const mine = await createCustomer({ legalName: `Owner Name ${tag} Pvt Ltd` });
    const unowned = await createCustomer({ legalName: `Owner Name ${tag} Unowned Pvt Ltd` });
    await withTx(db, a, systemActor('test'), async (tx) => {
      await tx.update(users).set({ displayName: 'Sita Sales' }).where(eq(users.id, a.userId));
      await tx.update(customers).set({ ownerUserId: null }).where(eq(customers.id, unowned.id));
    });
    const res = await request(baseUrl)
      .get('/v1/customers')
      .query({ q: `Owner Name ${tag}` });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = (res.body as { items: Record<string, unknown>[] }).items;
    const byId = new Map(items.map((c) => [c.id, c]));
    expect(byId.get(mine.id)).toMatchObject({ ownerUserId: a.userId, ownerName: 'Sita Sales' });
    expect(byId.get(unowned.id)).toMatchObject({ ownerUserId: null, ownerName: null });
    for (const item of items) {
      expect(CustomerDtoSchema.parse(item)).toBeDefined();
      expect(JSON.stringify(item)).not.toMatch(/@/);
    }
  });

  it('is a 400 without an Idempotency-Key and for a body that breaks the contract', async () => {
    const missing = await request(baseUrl).post('/v1/customers').send(customerBody());
    expect(missing.status).toBe(400);
    const invalid = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(customerBody({ panVatNo: 'x' }));
    expect(invalid.status).toBe(400);
  });

  it('runs a retried create once: same key and body replays, same key and another body is 422', async () => {
    const key = newKey();
    const body = customerBody();
    const first = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', key)
      .send(body);
    const replay = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', key)
      .send(body);
    expect(first.status).toBe(201);
    expect(replay.status).toBe(201);
    expect(replay.body).toEqual(first.body);
    const count = await ownerPool.query<{ n: string }>(
      'SELECT count(*) AS n FROM app.customers WHERE tenant_id = $1 AND legal_name = $2',
      [a.tenantId, body.legalName],
    );
    expect(count.rows[0]?.n).toBe('1');
    const other = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', key)
      .send(customerBody());
    expect(other.status).toBe(422);
  });
});

describe('"Create anyway" on a customer of the same name (F1-Q55)', () => {
  const post = (body: Record<string, unknown>) =>
    request(baseUrl).post('/v1/customers').set('Idempotency-Key', newKey()).send(body);
  const overrideEvents = async (customerId: string) => {
    const { rows } = await ownerPool.query(
      `SELECT actor_id, meta FROM audit.audit_events
        WHERE action = 'customer.duplicate_override' AND entity_id = $1`,
      [customerId],
    );
    return rows as { actor_id: string; meta: { reason: string; matchedCustomerIds: string[] } }[];
  };

  it('needs a reason when the name matches a live customer, then records who, why and which', async () => {
    const tag = randomUUID().slice(0, 6);
    const first = await createCustomer({ legalName: `Annapurna ${tag} Traders Pvt. Ltd.` });

    // The same name after normalising ("Pvt Ltd" and punctuation drop out): refused without a reason.
    const refused = await post(customerBody({ legalName: `annapurna  ${tag} traders` }));
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'bad_request',
      reason: 'duplicate_reason_required',
    });
    const none = await ownerPool.query(
      'SELECT count(*)::int AS n FROM app.customers WHERE tenant_id = $1 AND name_norm = $2',
      [a.tenantId, `annapurna ${tag} traders`],
    );
    expect(none.rows[0]).toEqual({ n: 1 });

    const created = await post(
      customerBody({
        legalName: `Annapurna ${tag} Traders`,
        duplicateOverrideReason: 'Separate branch billed on its own',
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const second = CustomerDtoSchema.parse(created.body);
    expect(await overrideEvents(second.id)).toEqual([
      {
        actor_id: a.userId,
        meta: {
          reason: 'Separate branch billed on its own',
          matchedCustomerIds: [first.id],
          matches: [{ customerId: first.id, on: ['name'] }],
        },
      },
    ]);
  });

  // The form flags the same PAN/VAT number after dropping spaces and hyphens (duplicate-check.ts); the server
  // asks for the reason, and audits it, for exactly that match too.
  it('needs a reason for the same PAN/VAT number written with hyphens, and audits which rule matched', async () => {
    const tag = randomUUID().slice(0, 6);
    const first = await createCustomer({
      legalName: `Kailash ${tag} Pvt. Ltd.`,
      panVatNo: '123456789',
      address: abroad,
    });

    const refused = await post(
      customerBody({
        legalName: `Different ${tag} Pvt. Ltd.`,
        panVatNo: '123-456-789',
        address: abroad,
      }),
    );
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'bad_request',
      reason: 'duplicate_reason_required',
    });
    expect(errorOf(refused.body).message).toContain('PAN/VAT number');

    const created = await post(
      customerBody({
        legalName: `Different ${tag} Pvt. Ltd.`,
        panVatNo: '123-456-789',
        address: abroad,
        duplicateOverrideReason: 'Sister company sharing the group PAN',
      }),
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const second = CustomerDtoSchema.parse(created.body);
    expect(second.panVatNo).toBe('123-456-789');
    expect(await overrideEvents(second.id)).toEqual([
      {
        actor_id: a.userId,
        meta: {
          reason: 'Sister company sharing the group PAN',
          matchedCustomerIds: [first.id],
          matches: [{ customerId: first.id, on: ['pan_vat'] }],
        },
      },
    ]);
  });

  it('needs no reason, and records nothing, for a new name or one the caller cannot read', async () => {
    const tag = randomUUID().slice(0, 6);
    const fresh = await createCustomer({ legalName: `Fresh ${tag} Pvt. Ltd.` });
    expect(await overrideEvents(fresh.id)).toEqual([]);
    // A reason sent with a name that matches nothing is accepted and not recorded.
    const extra = await createCustomer({
      legalName: `Lone ${tag} Pvt. Ltd.`,
      duplicateOverrideReason: 'Just in case',
    });
    expect(await overrideEvents(extra.id)).toEqual([]);

    // Another tenant's customer of the same name is not a duplicate here.
    asStaff(b);
    await createCustomer({ legalName: `Shared ${tag} Pvt. Ltd.` });
    asStaff(a);
    await createCustomer({ legalName: `Shared ${tag} Pvt. Ltd.` });

    // An `own` reader is not told about a colleague's customer it cannot see.
    await createCustomer({ legalName: `Hidden ${tag} Pvt. Ltd.` });
    current.grants = new Map<Permission, Scope>([
      ['customer.read', 'own'],
      ['customer.write', 'own'],
    ]);
    current.userId = (await createStaffUser(appPool, { ...a })).userId;
    const own = await post(customerBody({ legalName: `Hidden ${tag} Pvt. Ltd.` }));
    expect(own.status, JSON.stringify(own.body)).toBe(201);
    asStaff(a);
  });
});

describe('a duplicate PAN/VAT number', () => {
  it('is 409 naming the existing customer, whatever the case typed', async () => {
    const pan = panOf();
    const existing = await createCustomer({ panVatNo: pan });
    const res = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(customerBody({ panVatNo: pan.toLowerCase() }));
    expect(res.status).toBe(409);
    expect(errorOf(res.body).message).toContain(existing.number);
  });

  it('carries the code duplicate_pan_vat and the holder in the exception', async () => {
    const pan = panOf();
    const existing = await createCustomer({ panVatNo: pan });
    const error: unknown = await service
      .create(
        {
          legalName: 'Race Pvt. Ltd.',
          panVatNo: pan,
          relationship: 'prospect',
          address,
          contact: firstContact(),
        },
        newKey(),
      )
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictException);
    const conflict = error as ConflictException;
    expect(conflict.getStatus()).toBe(409);
    expect(conflict.getResponse()).toMatchObject({
      code: 'duplicate_pan_vat',
      details: { customerId: existing.id, number: existing.number },
    });
  });

  it('is also refused on PATCH, but the same number is fine in another tenant', async () => {
    const pan = panOf();
    const holder = await createCustomer({ panVatNo: pan });
    const other = await createCustomer();
    const patch = await request(baseUrl)
      .patch(`/v1/customers/${other.id}`)
      .send({ expectedVersion: other.version, panVatNo: pan });
    expect(patch.status).toBe(409);
    // Patching the holder with its own number is not a duplicate.
    const same = await request(baseUrl)
      .patch(`/v1/customers/${holder.id}`)
      .send({ expectedVersion: holder.version, panVatNo: pan, industry: 'Retail' });
    expect(same.status).toBe(200);

    asStaff(b);
    const inB = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(customerBody({ panVatNo: pan }));
    expect(inB.status).toBe(201);
  });
});

describe('PATCH with expectedVersion', () => {
  it('updates, bumps the version, recomputes name_norm and keeps what was not sent', async () => {
    const created = await createCustomer({ relationship: 'active', panVatNo: panOf() });
    const res = await request(baseUrl)
      .patch(`/v1/customers/${created.id}`)
      .send({ expectedVersion: 1, legalName: 'Everest Traders Private Limited' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const updated = CustomerDtoSchema.parse(res.body);
    expect(updated).toMatchObject({
      legalName: 'Everest Traders Private Limited',
      // Not sent, so not reset to the schema default 'prospect'.
      relationship: 'active',
      panVatNo: created.panVatNo,
      version: 2,
    });
    const [row] = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(row?.nameNorm).toBe('everest traders');
    const party = await ownerPool.query<{ name: string }>(
      'SELECT name FROM app.parties WHERE id = $1',
      [created.id],
    );
    expect(party.rows[0]?.name).toBe('Everest Traders Private Limited');
  });

  it('is 409 for a stale expectedVersion and leaves the row alone', async () => {
    const created = await createCustomer();
    const first = await request(baseUrl)
      .patch(`/v1/customers/${created.id}`)
      .send({ expectedVersion: 1, industry: 'Retail' });
    expect(first.status).toBe(200);
    const stale = await request(baseUrl)
      .patch(`/v1/customers/${created.id}`)
      .send({ expectedVersion: 1, industry: 'Mining' });
    expect(stale.status).toBe(409);
    const [row] = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(row).toMatchObject({ industry: 'Retail', version: 2 });
  });

  it('is 400 for an unknown owner, an empty edit and a missing expectedVersion; 404 for an unknown id', async () => {
    const created = await createCustomer();
    const patch = (body: unknown, id = created.id) =>
      request(baseUrl)
        .patch(`/v1/customers/${id}`)
        .send(body as object);
    // A new owner needs customers.owner.write (customers-owner.integration.test.ts); with it, an unknown user is a 400.
    current.grants.set('customers.owner.write', 'all');
    expect((await patch({ expectedVersion: 1, ownerUserId: randomUUID() })).status).toBe(400);
    expect((await patch({ expectedVersion: 1 })).status).toBe(400);
    expect((await patch({ industry: 'x' })).status).toBe(400);
    expect((await patch({ expectedVersion: 1, industry: 'x' }, randomUUID())).status).toBe(404);
  });

  it('accepts an owner who is a user of the tenant', async () => {
    const created = await createCustomer();
    const res = await request(baseUrl)
      .patch(`/v1/customers/${created.id}`)
      .send({ expectedVersion: 1, ownerUserId: a.userId });
    expect(res.status).toBe(200);
    expect((res.body as { ownerUserId: string }).ownerUserId).toBe(a.userId);
  });
});

describe('a caller from another tenant', () => {
  it('gets 404 on read, PATCH, contacts and does not see the customer in a list', async () => {
    const created = await createCustomer({ legalName: `Hidden ${randomUUID()}` });
    const contact = await request(baseUrl)
      .post(`/v1/customers/${created.id}/contacts`)
      .set('Idempotency-Key', newKey())
      .send({ fullName: 'Sita Rai' });
    expect(contact.status).toBe(201);

    asStaff(b);
    expect((await request(baseUrl).get(`/v1/customers/${created.id}`)).status).toBe(404);
    const patch = await request(baseUrl)
      .patch(`/v1/customers/${created.id}`)
      .send({ expectedVersion: 1, industry: 'Spy' });
    expect(patch.status).toBe(404);
    expect((await request(baseUrl).get(`/v1/customers/${created.id}/contacts`)).status).toBe(404);
    const post = await request(baseUrl)
      .post(`/v1/customers/${created.id}/contacts`)
      .set('Idempotency-Key', newKey())
      .send({ fullName: 'Intruder' });
    expect(post.status).toBe(404);
    const list = await request(baseUrl).get('/v1/customers').query({ q: 'Hidden' });
    expect((list.body as { items: unknown[] }).items).toEqual([]);

    // The row was not touched by the foreign PATCH.
    const [row] = await db.select().from(customers).where(eq(customers.id, created.id));
    expect(row).toMatchObject({ industry: null, version: 1 });
  });
});

describe('contacts', () => {
  it('creates a contact with a lower-cased e-mail and lists it, the primary one first', async () => {
    const customer = await createCustomer();
    const post = (body: object) =>
      request(baseUrl)
        .post(`/v1/customers/${customer.id}/contacts`)
        .set('Idempotency-Key', newKey())
        .send(body);
    const plain = await post({ fullName: 'Anil Shrestha', email: 'Anil@Example.COM' });
    expect(plain.status, JSON.stringify(plain.body)).toBe(201);
    expect(ContactDtoSchema.parse(plain.body)).toMatchObject({
      customerId: customer.id,
      email: 'anil@example.com',
      phone: null,
      isPrimary: false,
      version: 1,
    });
    // A later contact may have no email: the customer already has one with an address.
    const phoneOnly = await post({ fullName: 'Sita Rai', phone: '+9779812345678' });
    expect(phoneOnly.status, JSON.stringify(phoneOnly.body)).toBe(201);

    const list = await request(baseUrl).get(`/v1/customers/${customer.id}/contacts`);
    expect(list.status).toBe(200);
    // The first contact (made with the customer) is the primary one, then the rest by name.
    expect((list.body as { fullName: string }[]).map((c) => c.fullName)).toEqual([
      'First Contact',
      'Anil Shrestha',
      'Sita Rai',
    ]);

    // Contacts are audited too.
    const audited = await ownerPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'customer_contacts'`,
      [a.tenantId],
    );
    expect(Number(audited.rows[0]?.n)).toBeGreaterThanOrEqual(2);
  });

  it.each([
    '9812345678',
    '+0123456789',
    '+97798',
    // Nepal rules (FX8): a +977 number is a 10-digit mobile starting 9 or a 7 to 9 digit landline.
    '+9778123456789',
    '+977012345678',
  ])('is 400 for the invalid phone %s', async (phone) => {
    const customer = await createCustomer();
    const res = await request(baseUrl)
      .post(`/v1/customers/${customer.id}/contacts`)
      .set('Idempotency-Key', newKey())
      .send({ fullName: 'Sita Rai', phone });
    expect(res.status).toBe(400);
    const rows = await db
      .select()
      .from(customerContacts)
      .where(eq(customerContacts.customerId, customer.id));
    // Only the first contact made with the customer.
    expect(rows.map((r) => r.fullName)).toEqual(['First Contact']);
  });

  it('is also enforced by the database CHECKs, whatever the API does', async () => {
    const customer = await createCustomer();
    const insert = (over: Record<string, unknown>) =>
      ownerPool.query(
        `INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name, email_norm, phone_e164)
         VALUES ($1, $2, 'Raw', $3, $4)`,
        [a.tenantId, customer.id, over.email ?? null, over.phone ?? null],
      );
    await expect(insert({ phone: '9812345678' })).rejects.toMatchObject({
      constraint: 'customer_contacts_phone_e164_check',
    });
    await expect(insert({ email: 'Upper@Example.com' })).rejects.toMatchObject({
      constraint: 'customer_contacts_email_norm_check',
    });
  });

  it('is 409 for a second primary contact and 404 for an unknown customer', async () => {
    const customer = await createCustomer();
    const post = (id: string, body: object) =>
      request(baseUrl)
        .post(`/v1/customers/${id}/contacts`)
        .set('Idempotency-Key', newKey())
        .send(body);
    // The first contact, made with the customer, is already the primary one.
    const second = await post(customer.id, { fullName: 'Two', isPrimary: true });
    expect(second.status).toBe(409);
    expect(errorOf(second.body).code).toBe('primary_contact_exists');
    expect((await post(randomUUID(), { fullName: 'Nobody' })).status).toBe(404);
  });

  it('replays a retried create once', async () => {
    const customer = await createCustomer();
    const key = newKey();
    const send = () =>
      request(baseUrl)
        .post(`/v1/customers/${customer.id}/contacts`)
        .set('Idempotency-Key', key)
        .send({ fullName: 'Once Only' });
    const first = await send();
    const replay = await send();
    expect(replay.body).toEqual(first.body);
    const rows = await db
      .select()
      .from(customerContacts)
      .where(eq(customerContacts.customerId, customer.id));
    expect(rows.map((r) => r.fullName).sort()).toEqual(['First Contact', 'Once Only']);
  });
});

describe('a customer always has a contact with an email (quotations are emailed)', () => {
  const post = (customerId: string, body: object) =>
    request(baseUrl)
      .post(`/v1/customers/${customerId}/contacts`)
      .set('Idempotency-Key', newKey())
      .send(body);
  const contactsOf = (customerId: string) =>
    db.select().from(customerContacts).where(eq(customerContacts.customerId, customerId));

  it('creates the customer and its first contact together; the contact is the primary one', async () => {
    const res = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(
        customerBody({
          contact: { fullName: 'Maya Gurung', email: 'Maya@Example.COM', title: 'Director' },
        }),
      );
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const created = CustomerDtoSchema.parse(res.body);
    const rows = await contactsOf(created.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      fullName: 'Maya Gurung',
      emailNorm: 'maya@example.com',
      title: 'Director',
      isPrimary: true,
    });
  });

  it('is 400 without a first contact, or with one that has no valid email, and writes nothing', async () => {
    const legalName = `No Contact ${randomUUID().slice(0, 8)} Pvt. Ltd.`;
    for (const contact of [undefined, { fullName: 'No Mail' }, { fullName: 'Bad', email: 'x' }]) {
      const res = await request(baseUrl)
        .post('/v1/customers')
        .set('Idempotency-Key', newKey())
        .send({ legalName, address, ...(contact === undefined ? {} : { contact }) });
      expect(res.status, JSON.stringify(contact)).toBe(400);
    }
    expect(await db.select().from(customers).where(eq(customers.legalName, legalName))).toEqual([]);
  });

  it('leaves no customer behind when its first contact cannot be written', async () => {
    const legalName = `Half Made ${randomUUID().slice(0, 8)} Pvt. Ltd.`;
    const spy = vi
      .spyOn(service, 'createContactInTx')
      .mockRejectedValueOnce(new Error('contact insert failed'));
    try {
      await expect(service.create(customerBody({ legalName }) as never, newKey())).rejects.toThrow(
        'contact insert failed',
      );
    } finally {
      spy.mockRestore();
    }
    expect(await db.select().from(customers).where(eq(customers.legalName, legalName))).toEqual([]);
  });

  it('refuses a contact without an email (422 contact_email_required) while the customer has none', async () => {
    // A customer from before this rule: its only contact has no email.
    const customer = await createCustomer();
    await withTx(db, a, systemActor('test'), (tx) =>
      tx
        .update(customerContacts)
        .set({ emailNorm: null })
        .where(eq(customerContacts.customerId, customer.id)),
    );

    const refused = await post(customer.id, { fullName: 'Phone Only', phone: '+9779812345678' });
    expect(refused.status, JSON.stringify(refused.body)).toBe(422);
    expect(errorOf(refused.body).code).toBe('contact_email_required');
    expect((await contactsOf(customer.id)).map((r) => r.fullName)).toEqual(['First Contact']);

    // A contact with an email is fine, and after it a contact without one is too.
    expect(
      (await post(customer.id, { fullName: 'Has Mail', email: 'mail@example.com' })).status,
    ).toBe(201);
    expect(
      (await post(customer.id, { fullName: 'Phone Only', phone: '+9779812345678' })).status,
    ).toBe(201);
  });
});

describe('detail accounts', () => {
  it('lists the terms of the entities the caller can act for and no others', async () => {
    const customer = await createCustomer();
    // The caller is a Sales user of tenant A who acts for the default entity and entityA2; a third entity is not theirs.
    const { userId: salesUserId } = await createStaffUser(appPool, { ...a, roleKeys: ['sales'] });
    const entityA3 = randomUUID();
    await withTx(db, a, systemActor('test'), async (tx) => {
      await tx.insert(organizations).values({
        id: entityA3,
        tenantId: a.tenantId,
        organizationId: entityA3,
        code: 'TA3',
        name: 'Third entity',
        legalName: 'Third entity',
      });
      await tx.insert(userEntities).values({
        tenantId: a.tenantId,
        organizationId: entityA2,
        userId: salesUserId,
        isDefault: false,
      });
      for (const organizationId of [a.organizationId, entityA2, entityA3]) {
        await tx.insert(partyAccounts).values({
          tenantId: a.tenantId,
          organizationId,
          partyId: customer.id,
          creditLimit: '50000.00',
        });
      }
    });
    asStaff(a, a.organizationId, salesUserId);
    const res = await request(baseUrl).get(`/v1/customers/${customer.id}`);
    expect(res.status).toBe(200);
    const accounts = (res.body as { accounts: unknown[] }).accounts.map((x) =>
      PartyAccountDtoSchema.parse(x),
    );
    expect(accounts.map((x) => x.organizationId).sort()).toEqual(
      [a.organizationId, entityA2].sort(),
    );
    expect(accounts[0]).toMatchObject({
      partyId: customer.id,
      creditLimit: '50000.00',
      version: 1,
    });
  });

  it('names the legal entity on each terms row, as Sales, and adds nothing else (audit #16)', async () => {
    const customer = await createCustomer();
    const { userId: salesUserId } = await createStaffUser(appPool, { ...a, roleKeys: ['sales'] });
    await withTx(db, a, systemActor('test'), async (tx) => {
      await tx
        .insert(userEntities)
        .values({
          tenantId: a.tenantId,
          organizationId: entityA2,
          userId: salesUserId,
          isDefault: false,
        })
        .onConflictDoNothing();
      await tx.insert(partyAccounts).values({
        tenantId: a.tenantId,
        organizationId: entityA2,
        partyId: customer.id,
        creditLimit: '75000.00',
      });
    });
    asStaff(a, a.organizationId, salesUserId); // Sales grants, held in both entities
    const res = await request(baseUrl).get(`/v1/customers/${customer.id}`);
    expect(res.status).toBe(200);
    const rows = (res.body as { accounts: Record<string, unknown>[] }).accounts;
    const second = rows.find((x) => x.organizationId === entityA2);
    expect(second).toEqual({
      partyId: customer.id,
      organizationId: entityA2,
      organizationName: 'Second entity',
      paymentTermId: null,
      creditLimit: '75000.00',
      version: 1,
    });
    expect(PartyAccountDtoSchema.parse(second).organizationName).toBe('Second entity');
  });
});

describe('detail people (the account owner by name)', () => {
  /** The name a user of the fixtures has, read as the owner role so the test does not trust the API's lookup. */
  const nameOf = async (userId: string) => {
    const [row] = await db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, userId));
    expect(row?.displayName).toBeTruthy();
    return row!.displayName!;
  };
  const readPeople = async (id: string) => {
    const res = await request(baseUrl).get(`/v1/customers/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return (res.body as { people?: { userId: string; name: string }[] }).people;
  };

  it('names the owner for a Sales caller who owns the customer, without the admin directory', async () => {
    const customer = await createCustomer({ ownerUserId: a.userId });
    asStaff(a);
    expect(await readPeople(customer.id)).toEqual([
      { userId: a.userId, name: await nameOf(a.userId), avatarDocumentId: null },
    ]);
  });

  it('names a different owner, and only that owner, for a Sales colleague who reads the customer', async () => {
    const { userId: mate } = await createStaffUser(appPool, { ...a, roleKeys: ['sales'] });
    // Naming another owner on create needs customers.owner.write (R4c2 Q5a); asStaff below drops it again.
    current.grants.set('customers.owner.write', 'all');
    const customer = await createCustomer({ ownerUserId: mate });
    asStaff(a);
    expect(await readPeople(customer.id)).toEqual([
      { userId: mate, name: await nameOf(mate), avatarDocumentId: null },
    ]);
  });

  it('names nobody when the customer has no owner', async () => {
    // A create defaults the owner to the caller; an imported or older row may have none.
    const customer = await createCustomer();
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.update(customers).set({ ownerUserId: null }).where(eq(customers.id, customer.id)),
    );
    const res = await request(baseUrl).get(`/v1/customers/${customer.id}`);
    expect((res.body as { ownerUserId: string | null }).ownerUserId).toBeNull();
    expect(await readPeople(customer.id)).toEqual([]);
  });

  it("keeps another tenant's owner name in that tenant", async () => {
    asStaff(b);
    const theirs = await createCustomer({ ownerUserId: b.userId });
    const theirName = await nameOf(b.userId);
    expect(await readPeople(theirs.id)).toEqual([
      { userId: b.userId, name: theirName, avatarDocumentId: null },
    ]);

    asStaff(a);
    const res = await request(baseUrl).get(`/v1/customers/${theirs.id}`);
    expect(res.status).toBe(404);
    expect(JSON.stringify(res.body)).not.toContain(theirName);
    const mine = await createCustomer({ ownerUserId: a.userId });
    const people = await readPeople(mine.id);
    expect(people?.map((p) => p.userId)).toEqual([a.userId]);
    expect(JSON.stringify(people)).not.toContain(theirName);
  });

  it('is left out for a portal caller, who must not learn staff names', async () => {
    const mine = await createCustomer({ ownerUserId: a.userId });
    asPortal(a, mine.id);
    const own = await request(baseUrl).get(`/v1/customers/${mine.id}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('people');
  });
});

describe('detail can and verification presence (audit #6)', () => {
  type Detail = {
    can?: Record<string, boolean>;
    verification?: { exists: boolean };
  };
  const detail = async (id: string) => {
    const res = await request(baseUrl).get(`/v1/customers/${id}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Detail & Record<string, unknown>;
  };
  const addCase = async (partyId: string, t: Tenant = a) => {
    const [row] = await withTx(db, t, systemActor('test'), (tx) =>
      tx
        .insert(verificationCases)
        .values({
          tenantId: t.tenantId,
          partyId,
          partyKind: 'customer',
          status: 'submitted',
          reviewPolicy: 'document_review_v1',
          checklist: [],
          reason: 'internal reviewer note',
          // verification_cases_submission_check: a submitted case names who submitted it and when.
          submittedByUserId: t.userId,
          submittedAt: now,
          createdAt: now,
          updatedAt: now,
        })
        .returning({ id: verificationCases.id }),
    );
    return row!.id;
  };

  it('offers Sales verification on their own customer with no case yet', async () => {
    asStaff(a);
    const mine = await createCustomer({ ownerUserId: a.userId });
    const body = await detail(mine.id);
    expect(body.can).toEqual({
      write: true,
      readVerification: true,
      openVerification: true,
      creditLimit: false,
      owner: false,
      paymentTerms: true,
    });
    expect(body.verification).toEqual({ exists: false });
    // F1-Q31: the owner may invite the first portal admin once the customer's KYB case is approved.
    expect(body.portalAccess).toEqual({
      hasUser: false,
      canInvite: false,
      blocked: 'kyb_not_verified',
    });
  });

  it('offers the owner the first portal admin invite once the KYB case is approved (F1-Q31)', async () => {
    const { userId: reviewer } = await createStaffUser(appPool, { ...a, roleKeys: ['finance'] });
    asStaff(a);
    const mine = await createCustomer({ ownerUserId: a.userId });
    const now = new Date();
    await withTx(db, a, systemActor('test'), (tx) =>
      tx.insert(verificationCases).values({
        tenantId: a.tenantId,
        partyId: mine.id,
        partyKind: 'customer',
        status: 'approved',
        reviewPolicy: 'document_review_v1',
        checklist: [],
        submittedByUserId: a.userId,
        submittedAt: now,
        reviewerUserId: reviewer,
        decidedAt: now,
        createdAt: now,
        updatedAt: now,
      }),
    );
    const body = await detail(mine.id);
    expect(body.portalAccess).toEqual({ hasUser: false, canInvite: true, blocked: null });
  });

  it("tells Sales a colleague's customer has a case, without offering to start one or leaking the case", async () => {
    const { userId: mate } = await createStaffUser(appPool, { ...a, roleKeys: ['sales'] });
    asStaff(a);
    current.grants.set('customers.owner.write', 'all');
    const theirs = await createCustomer({ ownerUserId: mate });
    asStaff(a);
    const caseId = await addCase(theirs.id);

    const body = await detail(theirs.id);
    expect(body.can).toEqual({
      write: true,
      readVerification: false,
      openVerification: false,
      creditLimit: false,
      owner: false,
      paymentTerms: true,
    });
    // F1-Q31: only the account owner invites the first portal admin.
    expect(body.portalAccess).toEqual({ hasUser: false, canInvite: false, blocked: 'owner_only' });
    expect(body.verification).toEqual({ exists: true });
    // Existence only: nothing of the case itself (id, status, reviewer note) comes with the customer.
    const text = JSON.stringify(body);
    expect(text).not.toContain(caseId);
    expect(text).not.toContain('submitted');
    expect(text).not.toContain('internal reviewer note');
  });

  it("does not let a case of another tenant's party count", async () => {
    asStaff(a);
    const mine = await createCustomer({ ownerUserId: a.userId });
    asStaff(b);
    const theirs = await createCustomer({ ownerUserId: b.userId });
    await addCase(theirs.id, b);
    asStaff(a);
    expect((await detail(mine.id)).verification).toEqual({ exists: false });
  });

  it('is left out for a portal caller', async () => {
    const mine = await createCustomer({ ownerUserId: a.userId });
    asPortal(a, mine.id);
    const body = await detail(mine.id);
    expect(body).not.toHaveProperty('can');
    expect(body).not.toHaveProperty('verification');
  });
});

describe('a customer portal caller', () => {
  it('reads only its own company and sees no other customer, in a list or by id', async () => {
    const mine = await createCustomer();
    const theirs = await createCustomer();
    asPortal(a, mine.id);
    const own = await request(baseUrl).get(`/v1/customers/${mine.id}`);
    expect(own.status).toBe(200);
    expect(own.body).not.toHaveProperty('accounts');
    expect((await request(baseUrl).get(`/v1/customers/${theirs.id}`)).status).toBe(404);
    const list = await request(baseUrl).get('/v1/customers');
    expect((list.body as { items: { id: string }[] }).items.map((c) => c.id)).toEqual([mine.id]);
  });

  it('cannot write, even if a grant were given by mistake', async () => {
    const mine = await createCustomer();
    asPortal(a, mine.id);
    current.grants = new Map<Permission, Scope>([['customer.write', 'all']]);
    const res = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(customerBody());
    expect(res.status).toBe(403);
  });
});

describe('the Nepal PAN rule on the server (FX8)', () => {
  const patch = (id: string, body: object) =>
    request(baseUrl).patch(`/v1/customers/${id}`).send(body);

  it('refuses a short PAN for a Nepal customer on create and accepts nine digits', async () => {
    const short = await request(baseUrl)
      .post('/v1/customers')
      .set('Idempotency-Key', newKey())
      .send(customerBody({ panVatNo: '12345' }));
    expect(short.status, JSON.stringify(short.body)).toBe(400);
    expect(errorOf(short.body).message).toContain('PAN');
    await createCustomer({ panVatNo: panOf() });
  });

  const foreignPanOf = () => `AAACH${Math.floor(Math.random() * 1e6)}C`;

  it('keeps the loose tax id for a customer abroad', async () => {
    const foreignPan = foreignPanOf();
    const customer = await createCustomer({ panVatNo: foreignPan, address: abroad });
    expect(customer.panVatNo).toBe(foreignPan);
  });

  it('checks a PAN sent alone against the stored country, and a country sent alone against the stored PAN', async () => {
    const nepali = await createCustomer({ panVatNo: panOf() });
    const shortPan = await patch(nepali.id, { expectedVersion: nepali.version, panVatNo: '12345' });
    expect(shortPan.status, JSON.stringify(shortPan.body)).toBe(400);

    const foreign = await createCustomer({ panVatNo: foreignPanOf(), address: abroad });
    const toNepal = await patch(foreign.id, { expectedVersion: foreign.version, address });
    expect(toNepal.status, JSON.stringify(toNepal.body)).toBe(400);
    const fixed = await patch(foreign.id, {
      expectedVersion: foreign.version,
      address,
      panVatNo: panOf(),
    });
    expect(fixed.status, JSON.stringify(fixed.body)).toBe(200);
  });

  it('does not judge a legacy tax id while neither the PAN nor the country changes', async () => {
    const created = await createCustomer({ address: abroad });
    await withTx(db, a, systemActor('test'), (tx) =>
      tx
        .update(customers)
        .set({ panVatNo: 'LEGACY-1', address })
        .where(eq(customers.id, created.id)),
    );
    const res = await patch(created.id, { expectedVersion: created.version, industry: 'Retail' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });
});
