// Integration tests of the lost-deal report (round 5, P5 item 2) on a real Postgres. Real: migrations, queries as
// bos_app, LostReasonReportService, OpportunitiesService (the producer of Lost and of the stage history), Nest HTTP
// with the @Can route guard. Faked: the request context and authz.assert (the real pure can() decides).
// Run: pnpm --filter @bos/api exec vitest run src/modules/opportunities/lost-reason-report.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  type AccessLevel,
  DEFAULT_ROLE_PERMISSIONS,
  type LostReasonReport,
  LostReasonReportSchema,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  opportunities,
  opportunityStageHistory,
} from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { CAN_KEY } from '../../platform/authz/decorators';
import type { Principal } from '../../platform/authz/principal';
import type { Db } from '../../platform/db/db.module';
import { systemActor, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { LostReasonReportController } from './lost-reason-report.controller';
import {
  kathmanduMonth,
  LostReasonReportService,
  reportMonths,
} from './lost-reason-report.service';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityOwnersService } from './opportunity-owners.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type TenantScope = { tenantId: string; organizationId: string };
type Where = 'A' | 'B' | 'T2';

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let opportunitiesService: OpportunitiesService;
let report: LostReasonReportService;
const scopes = {} as Record<Where, TenantScope>;
const idp = {} as Record<Where, string>;
const customers = {} as Record<Where, string>;
const U = { salesA: '', salesB: '', boss: '', bossT2: '' };
let acting: TenantScope;
let actingIdp = '';

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; roles: RoleKey[]; level: AccessLevel } = {
  userId: '',
  roles: ['sales'],
  level: 'staff',
};
const as = (userId: string, role: RoleKey, where: Where = 'A') => {
  current.userId = userId;
  current.roles = [role];
  current.level = 'staff';
  acting = scopes[where];
  actingIdp = idp[where];
};
const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...acting,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: actingIdp,
  roles: current.roles,
  departmentId: null,
  level: current.level,
  status: 'active',
  grants: grantsOf(current.roles[0]!),
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

class RouteCanGuard implements CanActivate {
  constructor(private readonly reflector: Reflector) {}

  canActivate(context: ExecutionContext): boolean {
    const action = this.reflector.getAllAndOverride<Permission | undefined>(CAN_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (action !== undefined) authz.assert(action);
    return true;
  }
}

async function seedCustomer(inScope: TenantScope) {
  const { partyId } = await createParty(appPool, { tenantId: inScope.tenantId, kind: 'customer' });
  await withTx(db, inScope, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.customers
              (id, tenant_id, number, legal_name, name_norm, country, address_line, address_city)
          VALUES (${partyId}, ${inScope.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Acme Pvt. Ltd.',
                  'acme pvt. ltd.', 'NP', '1 Durbar Marg', 'Kathmandu')`,
    ),
  );
  return partyId;
}

const reasonIds = new Map<string, string>();
async function reasonId(label: string, where: Where = 'A'): Promise<string> {
  const key = `${where}:${label}`;
  const known = reasonIds.get(key);
  if (known !== undefined) return known;
  const saved = acting;
  acting = scopes[where];
  const audit = new AuditService(db);
  const found = (await new LeadLostReasonsService(db, audit, caller).choices()).find(
    (o) => o.label === label,
  );
  acting = saved;
  expect(found, `option ${label}`).toBeDefined();
  reasonIds.set(key, found!.id);
  return found!.id;
}

/**
 * A deal seeded straight into the table, optionally with moves to Lost at the given instants (history rows are
 * append-only, so a past lost date is written as its own row). `updatedAt` stands in when there is no history.
 */
async function seedDeal(options: {
  stage?: OpportunityStage;
  where?: Where;
  owner?: string;
  reason?: string | null;
  lostAt?: string[];
  updatedAt?: string;
}): Promise<string> {
  const where = options.where ?? 'A';
  const inScope = scopes[where];
  const stage = options.stage ?? 'lost';
  const lostReasonId =
    stage === 'lost' && options.reason !== null && options.reason !== undefined
      ? await reasonId(options.reason, where)
      : null;
  return withTx(db, inScope, systemActor('test'), async (tx) => {
    const [row] = await tx
      .insert(opportunities)
      .values({
        ...inScope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: customers[where],
        ownerUserId: options.owner ?? (where === 'T2' ? U.bossT2 : U.salesA),
        stage,
        lostReasonId,
        ...(stage === 'lost' ? { stageReason: 'seeded', stageNote: 'seeded note' } : {}),
        ...(options.updatedAt !== undefined ? { updatedAt: new Date(options.updatedAt) } : {}),
      })
      .returning({ id: opportunities.id });
    for (const at of options.lostAt ?? []) {
      await tx.insert(opportunityStageHistory).values({
        ...inScope,
        opportunityId: row!.id,
        fromStage: 'negotiation',
        toStage: 'lost',
        actorKind: 'system',
        actorUserId: null,
        createdAt: new Date(at),
      });
    }
    return row!.id;
  });
}

const lineOf = (r: LostReasonReport, label: string | null) =>
  r.rows.find((row) => (row.reason?.label ?? null) === label);

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 6 });
  db = drizzle({ client: appPool });

  const t1 = await createTenantWithEntity(appPool);
  scopes.A = { tenantId: t1.tenantId, organizationId: t1.organizationId };
  idp.A = t1.idpOrgId;
  const entityB = randomUUID();
  await withTx(db, scopes.A, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${entityB}, ${scopes.A.tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`}, ${`E-${entityB}`}, false)`,
    ),
  );
  scopes.B = { tenantId: scopes.A.tenantId, organizationId: entityB };
  idp.B = t1.idpOrgId;
  const t2 = await createTenantWithEntity(appPool);
  scopes.T2 = { tenantId: t2.tenantId, organizationId: t2.organizationId };
  idp.T2 = t2.idpOrgId;

  U.salesA = (await createStaffUser(appPool, { ...scopes.A, idpOrgId: idp.A })).userId;
  U.salesB = (await createStaffUser(appPool, { ...scopes.A, idpOrgId: idp.A })).userId;
  U.boss = (await createStaffUser(appPool, { ...scopes.A, idpOrgId: idp.A })).userId;
  U.bossT2 = (await createStaffUser(appPool, { ...scopes.T2, idpOrgId: idp.T2 })).userId;
  customers.A = await seedCustomer(scopes.A);
  customers.B = await seedCustomer(scopes.B);
  customers.T2 = await seedCustomer(scopes.T2);

  const audit = new AuditService(db);
  opportunitiesService = new OpportunitiesService(
    db,
    authz as unknown as AuthzService,
    audit,
    caller,
    new LeadLostReasonsService(db, audit, caller),
  );
  report = new LostReasonReportService(db, caller);

  const moduleRef = await Test.createTestingModule({
    controllers: [LostReasonReportController, OpportunitiesController],
    providers: [
      { provide: LostReasonReportService, useValue: report },
      { provide: OpportunitiesService, useValue: opportunitiesService },
      { provide: OpportunityOwnersService, useValue: {} },
      {
        provide: APP_GUARD,
        useFactory: (reflector: Reflector) => new RouteCanGuard(reflector),
        inject: [Reflector],
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
  await testDb?.drop();
});

beforeEach(() => {
  as(U.boss, 'founder');
});

describe('months', () => {
  it('defaults to the 12 months ending this month in Kathmandu, across a year end', () => {
    // 18:30Z on 31 Jan is 00:15 on 1 Feb in Kathmandu.
    const now = new Date('2026-01-31T18:30:00Z');
    expect(kathmanduMonth(now)).toBe('2026-02');
    const r = reportMonths({}, now);
    expect([r.from, r.to, r.months.length]).toEqual(['2025-03', '2026-02', 12]);
    expect(reportMonths({ from: '2025-11' }, now).to).toBe('2026-10');
    expect(reportMonths({ to: '2025-01' }, now).from).toBe('2024-02');
  });
});

describe('counts', () => {
  it('counts deals now Lost by reason and Kathmandu month, once per deal, with a no-reason bucket', async () => {
    await seedDeal({ reason: 'Price', lostAt: ['2025-03-10T06:00:00Z'] });
    // 18:30Z on 31 Mar is 00:15 on 1 Apr in Kathmandu; 18:00Z is still 23:45 on 31 Mar.
    await seedDeal({ reason: 'Price', lostAt: ['2025-03-31T18:30:00Z'] });
    await seedDeal({ reason: 'Timing', lostAt: ['2025-03-31T18:00:00Z'] });
    // Lost before history began: the last update stands in.
    await seedDeal({ reason: null, updatedAt: '2025-05-15T06:00:00Z' });
    // Lost, reopened and lost again: once, in the month of the latest loss.
    await seedDeal({ reason: 'Price', lostAt: ['2025-02-01T06:00:00Z', '2025-06-01T06:00:00Z'] });
    // Lost and then reopened: not lost any more.
    await seedDeal({ stage: 'qualified', lostAt: ['2025-03-05T06:00:00Z'] });
    // Outside the range.
    await seedDeal({ reason: 'Price', lostAt: ['2024-12-20T06:00:00Z'] });

    const r = await report.lostReasons({ from: '2025-01', to: '2025-06' });
    expect(r.months).toEqual(['2025-01', '2025-02', '2025-03', '2025-04', '2025-05', '2025-06']);
    expect(r.rows.map((row) => [row.reason?.label ?? null, row.counts, row.total])).toEqual([
      ['Price', [0, 0, 1, 1, 0, 1], 3],
      ['Timing', [0, 0, 1, 0, 0, 0], 1],
      [null, [0, 0, 0, 0, 1, 0], 1],
    ]);
    expect(r.monthTotals).toEqual([0, 0, 2, 1, 1, 1]);
    expect(r.total).toBe(5);
    expect(LostReasonReportSchema.parse(r)).toEqual(r);
  });

  it('counts a deal its owner marks Lost through the service, and drops it when reopened', async () => {
    const thisMonth = kathmanduMonth(new Date());
    const priceNow = async () => {
      const r = await report.lostReasons({ from: thisMonth, to: thisMonth });
      return lineOf(r, 'Price')?.counts[0] ?? 0;
    };
    as(U.salesA, 'sales');
    const before = await priceNow();
    const id = await seedDeal({ stage: 'negotiation' });
    await opportunitiesService.changeStage(id, {
      stage: 'lost',
      lostReasonId: await reasonId('Price'),
      note: 'went with a cheaper vendor',
      expectedVersion: 1,
    });
    expect(await priceNow()).toBe(before + 1);

    as(U.boss, 'founder');
    await opportunitiesService.changeStage(id, { stage: 'qualified', expectedVersion: 2 });
    as(U.salesA, 'sales');
    expect(await priceNow()).toBe(before);
  });
});

describe('access', () => {
  it('counts for an own-scope seller only the deals they may read', async () => {
    await seedDeal({ owner: U.salesB, reason: 'No budget', lostAt: ['2025-08-10T06:00:00Z'] });
    const range = { from: '2025-08', to: '2025-08' };

    as(U.salesA, 'sales');
    expect((await report.lostReasons(range)).total).toBe(0);
    as(U.salesB, 'sales');
    expect((await report.lostReasons(range)).total).toBe(1);
    as(U.boss, 'founder');
    expect((await report.lostReasons(range)).total).toBe(1);
  });

  it('never counts another entity or another tenant', async () => {
    await seedDeal({ where: 'B', reason: 'Price', lostAt: ['2025-09-10T06:00:00Z'] });
    await seedDeal({ where: 'T2', reason: 'Price', lostAt: ['2025-09-10T06:00:00Z'] });
    const range = { from: '2025-09', to: '2025-09' };

    as(U.boss, 'founder', 'A');
    expect((await report.lostReasons(range)).total).toBe(0);
    as(U.boss, 'founder', 'B');
    expect((await report.lostReasons(range)).total).toBe(1);
    as(U.bossT2, 'founder', 'T2');
    const t2 = await report.lostReasons(range);
    expect(t2.total).toBe(1);
    expect(t2.rows[0]!.reason?.id).toBe(await reasonId('Price', 'T2'));
  });
});

describe('GET /v1/opportunities/reports/lost-reasons', () => {
  const get = (query = '') =>
    request(baseUrl).get(`/v1/opportunities/reports/lost-reasons${query}`);

  it('answers a role that reads deals, by default over the last 12 months', async () => {
    as(U.salesA, 'sales');
    const res = await get();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const body = LostReasonReportSchema.parse(res.body);
    expect(body.months).toHaveLength(12);
    expect(body.to).toBe(kathmanduMonth(new Date()));
  });

  it('refuses a role without the deal read exactly as the opportunity list does', async () => {
    as(U.salesA, 'procurement');
    const list = await request(baseUrl).get('/v1/opportunities');
    const res = await get();
    expect(list.status).toBe(403);
    expect(res.status).toBe(403);
    // Same refusal; only the per-request correlation id differs.
    const without = (body: { error: Record<string, unknown> }) => {
      const { correlationId: _id, ...rest } = body.error;
      return rest;
    };
    expect(without(res.body as never)).toEqual(without(list.body as never));
    expect(without(res.body as never)).toMatchObject({
      code: 'forbidden',
      reason: 'no_permission',
    });
  });

  it.each([
    ['a malformed month', '?from=2025-13'],
    ['a day instead of a month', '?from=2025-01-01'],
    ['from after to', '?from=2025-06&to=2025-01'],
    ['more than 60 months', '?from=2020-01&to=2025-01'],
    ['a year far in the future', '?from=9999-12&to=9999-12'],
    ['an unknown parameter', '?period=month'],
  ])('rejects %s with 400', async (_name, query) => {
    const res = await get(query);
    expect(res.status, JSON.stringify(res.body)).toBe(400);
  });
});
