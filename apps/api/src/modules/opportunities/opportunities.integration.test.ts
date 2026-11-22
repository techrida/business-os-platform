// Integration tests of the opportunities API on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, the controller behind the production body parser and error
// filter, OpportunitiesService and the real AuditService (audit.record). Faked: the request context, and
// authz.assert, which still runs the real pure can() on a fake principal, so the ResourceRef the service builds
// is what decides 403 or 404. Every response is parsed with the contract schema the workspace uses.
// Opportunities have no create endpoint (leads convert into them), so rows are seeded with the schema.
// Run: pnpm --filter @bos/api exec vitest run src/modules/opportunities
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type AccessLevel,
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  OpportunityDtoSchema,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createParty, createStaffUser, createTenantWithEntity, opportunities } from '@bos/db';
import { ForbiddenException, NotFoundException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import type { Principal } from '../../platform/authz/principal';
import { RoleCache } from '../../platform/authz/role-cache';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx, type DbTransaction } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityOwnersService } from './opportunity-owners.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let service: OpportunitiesService;
let tenantId: string;
/** Entity A is the acting entity of every request below; entity B is another legal entity of the tenant. */
let scopeA: { tenantId: string; organizationId: string };
let scopeB: { tenantId: string; organizationId: string };
/** The scope the current request acts in. A test switches it to B to act as an entity-B caller. */
let acting: { tenantId: string; organizationId: string };
let staffIdpOrgId: string;
let customerA: string;
let customerB: string;
const U: Record<'salesA' | 'salesB' | 'boss' | 'viewer', string> = {
  salesA: randomUUID(),
  salesB: randomUUID(),
  boss: randomUUID(),
  viewer: randomUUID(),
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: {
  userId: string;
  roles: RoleKey[];
  level: AccessLevel;
  grants: Map<Permission, Scope>;
} = {
  userId: U.salesA,
  roles: ['sales'],
  level: 'staff',
  grants: grantsOf('sales'),
};
/** sales: own scope, may write. founder: all scope, so a manager. management: reads all, cannot write. */
const as = (userId: string, role: RoleKey, level: AccessLevel = 'staff') => {
  current.userId = userId;
  current.roles = [role];
  current.level = level;
  current.grants = grantsOf(role);
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...acting,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: staffIdpOrgId,
  roles: current.roles,
  departmentId: null,
  level: current.level,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: acting,
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

const newReasons = () => new LeadLostReasonsService(db, new AuditService(db), caller);
const newService = () => {
  const audit = new AuditService(db);
  return new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
};
const lostReasonIdOf = async (label: string): Promise<string> => {
  const found = (await newReasons().choices()).find((o) => o.label === label);
  expect(found, `option ${label}`).toBeDefined();
  return found!.id;
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  tenantId = tenant.tenantId;
  staffIdpOrgId = tenant.idpOrgId;
  scopeA = { tenantId, organizationId: tenant.organizationId };
  const entityB = randomUUID();
  // The audit trigger refuses a write without bos.actor_id, so the second entity is inserted through withTx
  // (audited under entity A, the acting entity), never with a bare pool query.
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`}, ${`E-${entityB}`}, false)`,
    ),
  );
  scopeB = { tenantId, organizationId: entityB };
  acting = scopeA;

  for (const key of ['salesA', 'salesB', 'boss', 'viewer'] as const) {
    U[key] = (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId })).userId;
  }
  customerA = await seedCustomer(scopeA);
  customerB = await seedCustomer(scopeB);

  service = newService();
  const moduleRef = await Test.createTestingModule({
    controllers: [OpportunitiesController],
    providers: [
      { provide: OpportunitiesService, useValue: service },
      {
        provide: OpportunityOwnersService,
        useValue: new OpportunityOwnersService(db, caller, new RoleCache(db)),
      },
    ],
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
  acting = scopeA;
  as(U.salesA, 'sales');
});

// ---------------------------------------------------------------------------------------- helpers

/** A customer party and its customers row (tenant-level), written under `inScope`'s entity. */
async function seedCustomer(
  inScope: { tenantId: string; organizationId: string },
  legalName = 'Acme Pvt. Ltd.',
) {
  const { partyId } = await createParty(appPool, { tenantId: inScope.tenantId, kind: 'customer' });
  await withTx(db, inScope, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
          VALUES (${partyId}, ${inScope.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, ${legalName},
                  ${legalName.toLowerCase()}, 'NP', '1 Durbar Marg', 'Kathmandu')`,
    ),
  );
  return partyId;
}

interface SeedOptions {
  owner?: string;
  stage?: OpportunityStage;
  name?: string;
  entity?: 'A' | 'B';
  createdAt?: Date;
  customerId?: string;
}

/**
 * A quotation on the opportunity with one Draft version, and the version's id. 0016 makes
 * won_quotation_version_id a foreign key to quotation_versions in the same entity, so a won row needs a real
 * version. A draft is enough for the key; each call makes its own quotation because a quotation has only one
 * live version.
 */
async function seedVersion(opportunityId: string, entity: 'A' | 'B' = 'A'): Promise<string> {
  const inScope = entity === 'B' ? scopeB : scopeA;
  return withTx(db, inScope, systemActor('test'), async (tx) => {
    const quotation = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
          VALUES (${inScope.tenantId}, ${inScope.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                  ${entity === 'B' ? customerB : customerA}, ${opportunityId})
          RETURNING id`,
    );
    const version = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotation_versions
            (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${inScope.tenantId}, ${inScope.organizationId}, ${quotation.rows[0]!.id}, 1, 'NPR',
                  '2026-11-09', '2026-12-09')
          RETURNING id`,
    );
    return version.rows[0]!.id;
  });
}

async function seed(options: SeedOptions = {}): Promise<string> {
  const inScope = options.entity === 'B' ? scopeB : scopeA;
  const stage = options.stage ?? 'qualified';
  const [row] = await withTx(db, inScope, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...inScope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: options.name ?? 'Acme website',
        customerId: options.customerId ?? (options.entity === 'B' ? customerB : customerA),
        ownerUserId: options.owner ?? U.salesA,
        ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
        // A won row needs the version it was won with, and the version needs the opportunity: insert at
        // quotation_sent, then move it to won below.
        stage: stage === 'won' ? 'quotation_sent' : stage,
        ...(stage === 'lost' || stage === 'on_hold'
          ? { stageReason: 'seeded', stageNote: 'seeded note' }
          : {}),
      })
      .returning({ id: opportunities.id }),
  );
  const id = row!.id;
  if (stage === 'won') {
    const wonQuotationVersionId = await seedVersion(id, options.entity);
    await withTx(db, inScope, systemActor('test'), (tx) =>
      tx
        .update(opportunities)
        .set({ stage: 'won', wonQuotationVersionId })
        .where(eq(opportunities.id, id)),
    );
  }
  return id;
}

const rowOf = async (id: string) => {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.id, id));
  return row!;
};

const patchStage = (id: string, body: Record<string, unknown>) =>
  request(baseUrl).patch(`/v1/opportunities/${id}/stage`).send(body);

const dto = (body: unknown) => OpportunityDtoSchema.parse(body);

const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

/** Domain and row events the audit trail holds for one opportunity, oldest first. */
async function auditOf(id: string) {
  const { rows } = await ownerPool.query<{ action: string; entity_type: string }>(
    `SELECT action, entity_type FROM audit.audit_events
      WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
    [tenantId, id],
  );
  return rows;
}

/** Runs `fn` in a transaction like a quotation service would open it, acting in `inScope`. */
const asSystem = <T>(
  inScope: { tenantId: string; organizationId: string },
  fn: (tx: DbTransaction) => Promise<T>,
) => withTx(db, inScope, systemActor('quotations'), fn);

// ------------------------------------------------------------------------------------------- tests

describe('GET /v1/opportunities', () => {
  it('returns a bare array that the workspace schema parses, limited to the caller scope', async () => {
    const mine = await seed({ owner: U.salesA, name: 'Mine' });
    const theirs = await seed({ owner: U.salesB, name: 'Theirs' });
    const otherEntity = await seed({ entity: 'B', owner: U.salesA, name: 'Other entity' });

    const res = await request(baseUrl).get('/v1/opportunities?limit=200');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const ids = z
      .array(OpportunityDtoSchema)
      .parse(res.body)
      .map((o) => o.id);
    expect(ids).toContain(mine);
    // `own` scope: a colleague's deal is not in the list, and neither is a deal of another entity.
    expect(ids).not.toContain(theirs);
    expect(ids).not.toContain(otherEntity);

    as(U.boss, 'founder');
    const all = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?limit=200')).body)
      .map((o) => o.id);
    expect(all).toEqual(expect.arrayContaining([mine, theirs]));
    expect(all).not.toContain(otherEntity);
  });

  it('filters by stage and by a name search, and treats % and _ as plain text', async () => {
    as(U.boss, 'founder');
    const hold = await seed({ stage: 'on_hold', name: 'Zeta 50% rollout' });
    const plain = await seed({ name: 'Zeta 500 units' });

    const byStage = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?stage=on_hold&limit=200')).body);
    expect(byStage.map((o) => o.id)).toContain(hold);
    expect(byStage.every((o) => o.stage === 'on_hold')).toBe(true);

    const percent = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=50%25')).body);
    // Fewer than five exact hits, so close matches may follow; the exact one is first.
    expect(percent[0]?.id).toBe(hold);
    const word = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=zeta&limit=200')).body);
    expect(word.map((o) => o.id)).toEqual(expect.arrayContaining([hold, plain]));
  });

  it("matches the customer's name case-insensitively and with a typo, and counts the matches", async () => {
    as(U.boss, 'founder');
    const zorvane = await seedCustomer(scopeA, 'Zorvane Quartzwerk Co');
    const deal = await seed({ name: 'Rooftop solar', customerId: zorvane });
    const other = await seed({ name: 'Office chairs' });

    const exact = await request(baseUrl).get('/v1/opportunities?q=QUARTZWERK&limit=200');
    expect(exact.status, JSON.stringify(exact.body)).toBe(200);
    const exactIds = z
      .array(OpportunityDtoSchema)
      .parse(exact.body)
      .map((o) => o.id);
    expect(exactIds[0]).toBe(deal);
    expect(exactIds).not.toContain(other);
    expect(Number(exact.headers['x-total-count'])).toBe(exactIds.length);

    // Fewer than five exact hits, so the close matches are included: the typo still finds the deal.
    const typo = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=Quartzwrek&limit=200')).body)
      .map((o) => o.id);
    expect(typo).toContain(deal);
  });

  it("does not search the customer's name for a caller who may not read customers", async () => {
    as(U.boss, 'founder');
    const vanta = await seedCustomer(scopeA, 'Vantablack Fabrication Co');
    const deal = await seed({ name: 'Press brake order', customerId: vanta });

    const allowed = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=Vantablack&limit=200')).body)
      .map((o) => o.id);
    expect(allowed).toContain(deal);

    current.grants.delete('customer.read');
    const denied = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=Vantablack&limit=200')).body)
      .map((o) => o.id);
    expect(denied).not.toContain(deal);
  });

  it('filters repeated stages together with search and scope before sorting and limiting', async () => {
    const name = 'North & West launch';
    const newest = new Date('2026-11-09T12:00:00Z');
    const qualified = await seed({
      name,
      stage: 'qualified',
      createdAt: new Date('2026-11-09T10:00:00Z'),
    });
    const negotiating = await seed({
      name,
      stage: 'negotiation',
      createdAt: new Date('2026-11-09T11:00:00Z'),
    });
    await seed({ name, stage: 'on_hold', createdAt: newest });
    await seed({ name: 'South launch', stage: 'qualified', createdAt: newest });
    await seed({ name, stage: 'qualified', owner: U.salesB, createdAt: newest });
    await seed({ name, stage: 'negotiation', entity: 'B', createdAt: newest });

    const res = await request(baseUrl).get(
      '/v1/opportunities?stage=qualified&stage=negotiation&q=North+%26+West&limit=2',
    );
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(
      z
        .array(OpportunityDtoSchema)
        .parse(res.body)
        .map((o) => o.id),
    ).toEqual([negotiating, qualified]);
  });

  it('honours limit and refuses a bad stage or limit with 400', async () => {
    as(U.boss, 'founder');
    await seed();
    await seed();
    const two = await request(baseUrl).get('/v1/opportunities?limit=2');
    expect(two.body).toHaveLength(2);
    expect((await request(baseUrl).get('/v1/opportunities?stage=nonsense')).status).toBe(400);
    expect(
      (await request(baseUrl).get('/v1/opportunities?stage=qualified&stage=nonsense')).status,
    ).toBe(400);
    expect((await request(baseUrl).get('/v1/opportunities?limit=0')).status).toBe(400);
    expect((await request(baseUrl).get('/v1/opportunities?limit=1000')).status).toBe(400);
  });

  it('pages with offset in a stable order and reports all matches in X-Total-Count', async () => {
    as(U.boss, 'founder');
    const sameTime = new Date('2026-11-10T08:00:00Z');
    const made: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      made.push(await seed({ name: 'Pagerun deal', createdAt: sameTime }));
    }
    const page = async (offset: number) => {
      const res = await request(baseUrl).get(
        `/v1/opportunities?q=pagerun&limit=2&offset=${offset}`,
      );
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(res.headers['x-total-count']).toBe('5');
      return z
        .array(OpportunityDtoSchema)
        .parse(res.body)
        .map((o) => o.id);
    };
    const seen = [...(await page(0)), ...(await page(2)), ...(await page(4))];
    // Equal createdAt: the id tiebreak keeps pages disjoint and complete.
    expect(new Set(seen).size).toBe(5);
    expect([...seen].sort()).toEqual([...made].sort());
    expect(await page(6)).toEqual([]);
  });

  it('filters by repeated owner and never widens the caller scope', async () => {
    const mine = await seed({ owner: U.salesA, name: 'Ownerfilter one' });
    const theirs = await seed({ owner: U.salesB, name: 'Ownerfilter two' });
    const otherEntity = await seed({ entity: 'B', owner: U.salesA, name: 'Ownerfilter three' });
    const get = async (query: string) => {
      const res = await request(baseUrl).get(`/v1/opportunities?q=ownerfilter&${query}`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return {
        ids: z
          .array(OpportunityDtoSchema)
          .parse(res.body)
          .map((o) => o.id),
        total: res.headers['x-total-count'],
      };
    };

    // `own` scope: asking for a colleague's deals by owner returns nothing, and the total says so.
    expect(await get(`owner=${U.salesB}`)).toEqual({ ids: [], total: '0' });
    expect(await get(`owner=${U.salesA}&owner=${U.salesB}`)).toEqual({ ids: [mine], total: '1' });

    as(U.boss, 'founder');
    expect((await get(`owner=${U.salesB}`)).ids).toEqual([theirs]);
    const both = await get(`owner=${U.salesA}&owner=${U.salesB}`);
    expect([...both.ids].sort()).toEqual([mine, theirs].sort());
    expect(both.ids).not.toContain(otherEntity);
    expect(both.total).toBe('2');
  });

  it('finds a close spelling only when there are few exact matches, and keeps the scope', async () => {
    as(U.boss, 'founder');
    const close = await seed({ name: 'Himalyan Traders Pvt Ltd' });
    const hidden = await seed({ name: 'Himalyan Exports', entity: 'B' });
    const res = await request(baseUrl).get('/v1/opportunities?q=Himalayan');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const ids = z
      .array(OpportunityDtoSchema)
      .parse(res.body)
      .map((o) => o.id);
    expect(ids).toContain(close);
    expect(ids).not.toContain(hidden);
    expect(Number(res.headers['x-total-count'])).toBe(ids.length);

    // An exact substring match ranks before the close ones.
    const exact = await seed({ name: 'Himalayan Hydro' });
    const ranked = z
      .array(OpportunityDtoSchema)
      .parse((await request(baseUrl).get('/v1/opportunities?q=Himalayan')).body)
      .map((o) => o.id);
    expect(ranked.indexOf(exact)).toBeLessThan(ranked.indexOf(close));
  });

  it('refuses an unknown owner, a repeated q and an unknown param with 400', async () => {
    for (const query of ['owner=nobody', 'q=ab&q=cd', 'sort=name', 'offset=-1']) {
      expect((await request(baseUrl).get(`/v1/opportunities?${query}`)).status, query).toBe(400);
    }
  });
});

describe('GET /v1/opportunities/:id', () => {
  it('returns the opportunity DTO', async () => {
    const id = await seed();
    const res = await request(baseUrl).get(`/v1/opportunities/${id}`);
    expect(res.status).toBe(200);
    expect(dto(res.body)).toMatchObject({
      id,
      stage: 'qualified',
      version: 1,
      customerId: customerA,
    });
  });

  it('answers 404, not 403, for another entity, a colleague own record or an unknown id', async () => {
    const otherEntity = await seed({ entity: 'B' });
    const colleague = await seed({ owner: U.salesB });
    for (const id of [otherEntity, colleague, randomUUID()]) {
      const res = await request(baseUrl).get(`/v1/opportunities/${id}`);
      expect(res.status, id).toBe(404);
      expect(errorOf(res.body).code).toBe('not_found');
    }
    expect((await request(baseUrl).get('/v1/opportunities/not-a-uuid')).status).toBe(400);
  });

  it('is refused (403) without crm.opportunity.read', async () => {
    const id = await seed();
    current.grants = new Map();
    expect((await request(baseUrl).get(`/v1/opportunities/${id}`)).status).toBe(403);
  });
});

describe('PATCH /v1/opportunities/:id/stage', () => {
  it('moves along a user edge, bumps the version and audits the change', async () => {
    const id = await seed();
    const res = await patchStage(id, { stage: 'requirement_received', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({ id, stage: 'requirement_received', version: 2 });
    const events = await auditOf(id);
    // The row trigger records the update; the domain event carries the move.
    expect(events.map((e) => e.action)).toContain('opportunity.stage_changed');
    expect(events.filter((e) => e.entity_type === 'opportunities').length).toBeGreaterThanOrEqual(
      2,
    );
  });

  it('refuses a user won and quotation_sent, and leaves the row alone', async () => {
    const id = await seed({ stage: 'negotiation' });
    for (const stage of ['won', 'quotation_sent']) {
      const res = await patchStage(id, { stage, expectedVersion: 1 });
      expect(res.status, stage).toBe(400);
    }
    // Even the service, called without the controller's parsing, refuses the system moves.
    await expect(
      service.changeStage(id, { stage: 'won', expectedVersion: 1 } as never),
    ).rejects.toMatchObject({ status: 409 });
    expect(await rowOf(id)).toMatchObject({ stage: 'negotiation', version: 1 });
  });

  it('needs both a reason and a note for lost and on_hold, and stores them', async () => {
    const id = await seed({ stage: 'negotiation' });
    for (const body of [
      { stage: 'lost' },
      { stage: 'lost', reason: 'price' },
      { stage: 'lost', note: 'too dear' },
      { stage: 'on_hold' },
    ]) {
      const res = await patchStage(id, { ...body, expectedVersion: 1 });
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(await rowOf(id)).toMatchObject({ stage: 'negotiation', version: 1 });

    const held = await patchStage(id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'revisit in Q3',
      expectedVersion: 1,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(dto(held.body)).toMatchObject({
      stage: 'on_hold',
      stageReason: 'budget',
      stageNote: 'revisit in Q3',
    });

    // Leaving on_hold clears the text, so a later stage never shows an old reason.
    const back = await patchStage(id, { stage: 'negotiation', expectedVersion: 2 });
    expect(dto(back.body)).toMatchObject({
      stage: 'negotiation',
      stageReason: null,
      stageNote: null,
    });
  });

  it('records the stage a deal is held at and resumes it there; an older hold resumes to negotiation (F1-Q53)', async () => {
    const id = await seed({ stage: 'negotiation' });
    const held = await patchStage(id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'revisit in Q3',
      expectedVersion: 1,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(dto(held.body)).toMatchObject({
      heldFromStage: 'negotiation',
      allowedMoves: ['negotiation'],
    });
    expect(await rowOf(id)).toMatchObject({ stage: 'on_hold', heldFromStage: 'negotiation' });
    const back = await patchStage(id, { stage: 'negotiation', expectedVersion: 2 });
    expect(dto(back.body)).toMatchObject({ stage: 'negotiation', heldFromStage: null });
    expect(await rowOf(id)).toMatchObject({ heldFromStage: null });

    // A row put on hold before 0100 has no held stage and resumes to the old fixed stage.
    const legacy = await seed({ stage: 'on_hold' });
    expect(await rowOf(legacy)).toMatchObject({ heldFromStage: null });
    const resumed = await patchStage(legacy, { stage: 'negotiation', expectedVersion: 1 });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
  });

  it('answers 409 for a stale version, before it judges the move', async () => {
    const id = await seed();
    expect(
      (await patchStage(id, { stage: 'requirement_received', expectedVersion: 1 })).status,
    ).toBe(200);
    const stale = await patchStage(id, { stage: 'proposal_sent', expectedVersion: 1 });
    expect(stale.status).toBe(409);
    expect(errorOf(stale.body).message).toMatch(/changed by someone else/);
    // A stale version on a move that is not an edge is still "stale", not "invalid move".
    const staleBad = await patchStage(id, { stage: 'negotiation', expectedVersion: 1 });
    expect(staleBad.status).toBe(409);
    expect(errorOf(staleBad.body).message).toMatch(/changed by someone else/);
    expect(await rowOf(id)).toMatchObject({ stage: 'requirement_received', version: 2 });
  });

  it('lets exactly one of two writers with the same version win', async () => {
    const id = await seed();
    const noBudget = await lostReasonIdOf('No budget');
    const [a, b] = await Promise.all([
      patchStage(id, { stage: 'requirement_received', expectedVersion: 1 }),
      patchStage(id, {
        stage: 'lost',
        lostReasonId: noBudget,
        note: 'client went quiet',
        expectedVersion: 1,
      }),
    ]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect((await rowOf(id)).version).toBe(2);
  });

  it('answers 409 for a move the stage machine does not have', async () => {
    const id = await seed();
    const res = await patchStage(id, { stage: 'negotiation', expectedVersion: 1 });
    expect(res.status).toBe(409);
    expect(errorOf(res.body).message).toMatch(/cannot move from qualified to negotiation/);
    const same = await patchStage(id, { stage: 'qualified', expectedVersion: 1 });
    expect(same.status).toBe(409);
  });

  it('refuses reopen of a lost opportunity for staff-level sales, and allows manager, head or founder with write scope', async () => {
    const id = await seed({ stage: 'lost' });
    // Staff-level sales gets 403.
    as(U.salesA, 'sales', 'staff');
    const staffRes = await patchStage(id, { stage: 'qualified', expectedVersion: 1 });
    expect(staffRes.status).toBe(403);
    expect(await rowOf(id)).toMatchObject({ stage: 'lost', version: 1 });

    // Read-only management gets 403 even at head level.
    as(U.viewer, 'management', 'head');
    expect((await patchStage(id, { stage: 'qualified', expectedVersion: 1 })).status).toBe(403);

    // Manager-level sales with write scope on their own opportunity succeeds.
    as(U.salesA, 'sales', 'manager');
    const mgrRes = await patchStage(id, { stage: 'qualified', expectedVersion: 1 });
    expect(mgrRes.status, JSON.stringify(mgrRes.body)).toBe(200);
    expect(await rowOf(id)).toMatchObject({ stage: 'qualified', version: 2 });

    // Founder succeeds on any lost opportunity in the entity.
    const id2 = await seed({ stage: 'lost' });
    as(U.boss, 'founder');
    const bossRes = await patchStage(id2, { stage: 'qualified', expectedVersion: 1 });
    expect(bossRes.status, JSON.stringify(bossRes.body)).toBe(200);
    expect(await rowOf(id2)).toMatchObject({ stage: 'qualified', version: 2 });
  });

  it('answers 404 for another entity and for a colleague own record, and 403 without write', async () => {
    const otherEntity = await seed({ entity: 'B' });
    const colleague = await seed({ owner: U.salesB });
    for (const id of [otherEntity, colleague]) {
      const res = await patchStage(id, { stage: 'requirement_received', expectedVersion: 1 });
      expect(res.status, id).toBe(404);
      expect(await rowOf(id)).toMatchObject({ stage: 'qualified', version: 1 });
    }
    // Even a founder acting in entity A cannot reach an entity-B row.
    as(U.boss, 'founder');
    expect(
      (await patchStage(otherEntity, { stage: 'requirement_received', expectedVersion: 1 })).status,
    ).toBe(404);

    const own = await seed();
    as(U.viewer, 'management');
    expect(
      (await patchStage(own, { stage: 'requirement_received', expectedVersion: 1 })).status,
    ).toBe(403);
  });

  it('rejects an unknown stage, extra fields and a missing version with 400', async () => {
    const id = await seed();
    for (const body of [
      { stage: 'nope', expectedVersion: 1 },
      { stage: 'requirement_received' },
      { stage: 'requirement_received', expectedVersion: 1, version: 9 },
    ]) {
      expect((await patchStage(id, body)).status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe('markQuotationSent and markWon (system only, no HTTP route)', () => {
  it('moves qualified to quotation_sent, and is a no-op when already sent or in negotiation', async () => {
    const id = await seed();
    const sent = await asSystem(scopeA, (tx) => service.markQuotationSent(tx, id));
    expect(sent).toMatchObject({ stage: 'quotation_sent', version: 2 });
    expect(await rowOf(id)).toMatchObject({ stage: 'quotation_sent', version: 2 });
    expect((await auditOf(id)).map((e) => e.action)).toContain('opportunity.quotation_sent');

    const again = await asSystem(scopeA, (tx) => service.markQuotationSent(tx, id));
    expect(again).toMatchObject({ stage: 'quotation_sent', version: 2 });

    const negotiating = await seed({ stage: 'negotiation' });
    const revised = await asSystem(scopeA, (tx) => service.markQuotationSent(tx, negotiating));
    expect(revised).toMatchObject({ stage: 'negotiation', version: 1 });
  });

  it('refuses markQuotationSent from won, lost and on_hold with 409', async () => {
    for (const stage of ['won', 'lost', 'on_hold'] as const) {
      const id = await seed({ stage });
      await expect(
        asSystem(scopeA, (tx) => service.markQuotationSent(tx, id)),
      ).rejects.toMatchObject({ status: 409 });
      expect((await rowOf(id)).stage).toBe(stage);
    }
  });

  it('sets won with the accepted quotation version, from quotation_sent and from negotiation', async () => {
    const id = await seed();
    await asSystem(scopeA, (tx) => service.markQuotationSent(tx, id));
    const versionId = await seedVersion(id);
    const won = await asSystem(scopeA, (tx) => service.markWon(tx, id, versionId));
    expect(won).toMatchObject({ stage: 'won', wonQuotationVersionId: versionId, version: 3 });
    expect(dto(won)).toMatchObject({ stage: 'won' });
    expect(await rowOf(id)).toMatchObject({ stage: 'won', wonQuotationVersionId: versionId });
    expect((await auditOf(id)).map((e) => e.action)).toContain('opportunity.won');

    const negotiating = await seed({ stage: 'negotiation' });
    const v2 = await seedVersion(negotiating);
    expect(await asSystem(scopeA, (tx) => service.markWon(tx, negotiating, v2))).toMatchObject({
      stage: 'won',
      wonQuotationVersionId: v2,
    });
  });

  it('is idempotent for the same version and a 409 for another one, or from qualified', async () => {
    const id = await seed({ stage: 'quotation_sent' });
    const versionId = await seedVersion(id);
    const otherVersionId = await seedVersion(id);
    await asSystem(scopeA, (tx) => service.markWon(tx, id, versionId));
    const again = await asSystem(scopeA, (tx) => service.markWon(tx, id, versionId));
    expect(again).toMatchObject({ stage: 'won', version: 2 });
    await expect(
      asSystem(scopeA, (tx) => service.markWon(tx, id, otherVersionId)),
    ).rejects.toMatchObject({
      status: 409,
    });
    expect((await rowOf(id)).wonQuotationVersionId).toBe(versionId);

    // qualified has no edge to won: the quotation must be sent first.
    const fresh = await seed();
    await expect(
      asSystem(scopeA, (tx) => service.markWon(tx, fresh, randomUUID())),
    ).rejects.toMatchObject({ status: 409 });
    expect((await rowOf(fresh)).stage).toBe('qualified');
  });

  it('cannot reach an opportunity of another entity (404, row unchanged)', async () => {
    const inB = await seed({ entity: 'B', stage: 'quotation_sent' });
    await expect(
      asSystem(scopeA, (tx) => service.markWon(tx, inB, randomUUID())),
    ).rejects.toBeInstanceOf(NotFoundException);
    const inB2 = await seed({ entity: 'B' });
    await expect(
      asSystem(scopeA, (tx) => service.markQuotationSent(tx, inB2)),
    ).rejects.toBeInstanceOf(NotFoundException);
    expect(await rowOf(inB)).toMatchObject({ stage: 'quotation_sent', version: 1 });
    expect(await rowOf(inB2)).toMatchObject({ stage: 'qualified', version: 1 });
    // The same call in the owning entity works.
    expect(await asSystem(scopeB, (tx) => service.markQuotationSent(tx, inB2))).toMatchObject({
      stage: 'quotation_sent',
    });
  });

  it('rolls back with the caller transaction', async () => {
    const id = await seed({ stage: 'quotation_sent' });
    const versionId = await seedVersion(id);
    await expect(
      asSystem(scopeA, async (tx) => {
        await service.markWon(tx, id, versionId);
        throw new Error('the quotation write failed');
      }),
    ).rejects.toThrow('the quotation write failed');
    expect(await rowOf(id)).toMatchObject({ stage: 'quotation_sent', version: 1 });
  });
});

describe('onLost port', () => {
  it('calls a registered handler in the same transaction, and a failing handler keeps the opportunity open', async () => {
    const svc = newService();
    const seen: { opportunityId: string; reason: string; note: string }[] = [];
    svc.registerLostHandler({
      name: 'quotations.cancel',
      onLost: (_tx, event) => {
        seen.push(event);
        return Promise.resolve();
      },
    });
    expect(() =>
      svc.registerLostHandler({ name: 'quotations.cancel', onLost: () => Promise.resolve() }),
    ).toThrow(/already registered/);

    const price = await lostReasonIdOf('Price');
    const id = await seed({ stage: 'negotiation' });
    const lost = await svc.changeStage(id, {
      stage: 'lost',
      lostReasonId: price,
      note: 'went with a cheaper vendor',
      expectedVersion: 1,
    });
    expect(lost.stage).toBe('lost');
    expect(seen).toEqual([
      expect.objectContaining({
        opportunityId: id,
        reason: 'Price',
        note: 'went with a cheaper vendor',
      }),
    ]);

    // A move to another stage does not call it.
    const other = await seed({ stage: 'negotiation' });
    await svc.changeStage(other, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'later',
      expectedVersion: 1,
    });
    expect(seen).toHaveLength(1);

    const failing = newService();
    failing.registerLostHandler({
      name: 'quotations.cancel',
      onLost: () => Promise.reject(new Error('cannot cancel the open quotation')),
    });
    const open = await seed({ stage: 'negotiation' });
    await expect(
      failing.changeStage(open, {
        stage: 'lost',
        lostReasonId: price,
        note: 'n',
        expectedVersion: 1,
      }),
    ).rejects.toThrow('cannot cancel the open quotation');
    expect(await rowOf(open)).toMatchObject({ stage: 'negotiation', version: 1 });
  });
});
