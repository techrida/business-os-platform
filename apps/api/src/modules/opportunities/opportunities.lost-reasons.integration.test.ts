// Opportunities marked Lost use the shared per-tenant lost-reason list (D49, D54-3): pick an option, add a new one
// shared with leads, refuse duplicates / unknown / retired options, show renames and retired flags on old deals,
// clear lost_reason_id when leaving lost or on a system move, and expose GET /v1/opportunity-lost-reasons behind
// crm.opportunity.write without requiring crm.lead.write.
// Real: migrations, OpportunitiesService, LeadsService, LeadLostReasonsService, AuditService, Nest HTTP + @Can guard.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_LEAD_LOST_REASONS,
  ErrorBodySchema,
  LeadDtoSchema,
  LeadLostReasonSchema,
  OpportunityDtoSchema,
  type OpportunityStage,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { leadLostReasons, opportunities } from '@bos/db';
import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  type INestApplication,
} from '@nestjs/common';
import { APP_GUARD, Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { CAN_KEY } from '../../platform/authz/decorators';
import { systemActor, withTx } from '../../platform/db/tx';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { NumberingService } from '../../platform/settings/numbering.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';
import { LeadsController } from '../leads/leads.controller';
import { LeadsService } from '../leads/leads.service';
import { LeadLostReasonsController } from '../leads/lost-reasons.controller';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { startHarness, type Harness, type TestUser } from '../leads/test/harness';
import { OpportunitiesController } from './opportunities.controller';
import { OpportunitiesService } from './opportunities.service';
import { OpportunityOwnersService } from './opportunity-owners.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let opportunitiesService: OpportunitiesService;
let customerId: string;
let seq = 0;

/** Mutable per-test grants so we can act as a role with crm.opportunity.write and NO crm.lead.write. */
let customGrants: Map<Permission, Scope> | null = null;

function activePrincipal() {
  const base = h.caller.current().principal;
  return customGrants === null ? base : { ...base, grants: customGrants };
}

const caller = {
  current: () => {
    const cur = h.caller.current();
    return { ...cur, principal: activePrincipal() };
  },
};

const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(activePrincipal(), action, ref);
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

const asRole = (user: TestUser, role: RoleKey) => {
  customGrants = null;
  h.as(user, role);
};

const asGrants = (user: TestUser, grants: Partial<Record<Permission, Scope>>) => {
  h.as(user, 'sales');
  customGrants = new Map(Object.entries(grants)) as Map<Permission, Scope>;
};

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  customerId = await h.seedCustomer(h.users.salesA);
  const audit = new AuditService(h.db);
  const reasons = new LeadLostReasonsService(h.db, audit, caller);
  const leadsService = new LeadsService(
    h.db,
    authz as unknown as AuthzService,
    audit,
    new NumberingService(),
    caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    reasons,
    h.roleCache,
    h.notify,
  );
  opportunitiesService = new OpportunitiesService(
    h.db,
    authz as unknown as AuthzService,
    audit,
    caller,
    reasons,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [OpportunitiesController, LeadsController, LeadLostReasonsController],
    providers: [
      { provide: OpportunitiesService, useValue: opportunitiesService },
      {
        provide: OpportunityOwnersService,
        useValue: new OpportunityOwnersService(h.db, caller, h.roleCache),
      },
      { provide: LeadsService, useValue: leadsService },
      { provide: LeadLostReasonsService, useValue: reasons },
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
  await h?.stop();
});

beforeEach(() => {
  asRole('salesA', 'sales');
});

const oppDto = (body: unknown) => OpportunityDtoSchema.parse(body);
const leadDto = (body: unknown) => LeadDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const optionsSchema = LeadLostReasonSchema.array();

async function seedOpportunity(stage: OpportunityStage = 'negotiation'): Promise<string> {
  seq += 1;
  const id = randomUUID();
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(opportunities).values({
      id,
      tenantId: h.tenantId,
      organizationId: h.scopeA.organizationId,
      number: `DEAL-LR-${String(seq).padStart(4, '0')}`,
      name: `Deal ${seq}`,
      customerId,
      ownerUserId: h.users.salesA,
      stage,
      value: '250000.00',
      currency: 'NPR',
    }),
  );
  return id;
}

async function seedLead() {
  const res = await request(baseUrl).post('/v1/leads').send({
    title: 'Shared lost reason lead',
    source: 'referral',
    companyName: 'Acme Pvt. Ltd.',
    contactName: 'Sita Rai',
    // FX9: a lead names its country and a way to reach the person (an email or a phone).
    country: 'NP',
    email: 'sita.rai@acme.example',
    currency: 'NPR',
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return leadDto(res.body);
}

async function adminList() {
  asRole('boss', 'founder');
  const res = await request(baseUrl).get('/v1/admin/lead-lost-reasons');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return optionsSchema.parse(res.body);
}

async function labelOf(label: string) {
  const found = (await adminList()).find((o) => o.label === label);
  expect(found, `option ${label}`).toBeDefined();
  return found!;
}

const markOpportunityLost = (id: string, version: number, pick: Record<string, unknown>) =>
  request(baseUrl)
    .patch(`/v1/opportunities/${id}/stage`)
    .send({ stage: 'lost', note: 'Buyer paused project', expectedVersion: version, ...pick });

async function getOpportunity(id: string) {
  const res = await request(baseUrl).get(`/v1/opportunities/${id}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return oppDto(res.body);
}

async function auditRowsOf(entityId: string) {
  const { rows } = await h.ownerPool.query(
    `SELECT action, meta FROM audit.audit_events
      WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
    [h.tenantId, entityId],
  );
  return rows as { action: string; meta: Record<string, unknown> | null }[];
}

describe('D49 / D54-3 opportunity lost reasons', () => {
  it('stores lostReasonId, returns dto.lostReason on detail and list, sets stageReason to the label, and records audit meta', async () => {
    const price = await labelOf('Price');
    asRole('salesA', 'sales');
    const id = await seedOpportunity();

    const res = await markOpportunityLost(id, 1, { lostReasonId: price.id });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(oppDto(res.body)).toMatchObject({
      stage: 'lost',
      stageReason: 'Price',
      stageNote: 'Buyer paused project',
      lostReason: { id: price.id, label: 'Price', retired: false },
    });

    const [row] = await h.db.select().from(opportunities).where(eq(opportunities.id, id));
    expect(row).toMatchObject({ lostReasonId: price.id, stageReason: 'Price' });

    const listed = await request(baseUrl).get('/v1/opportunities?limit=200');
    expect(listed.status).toBe(200);
    const inList = OpportunityDtoSchema.array()
      .parse(listed.body)
      .find((o) => o.id === id);
    expect(inList?.lostReason).toEqual({ id: price.id, label: 'Price', retired: false });

    const events = await auditRowsOf(id);
    const stageEvent = events.find((e) => e.action === 'opportunity.stage_changed');
    expect(stageEvent?.meta).toMatchObject({
      reason: 'Price',
      note: 'Buyer paused project',
      lostReasonId: price.id,
    });
  });

  it('refuses an unknown option (400) and a retired option (400), while an already-lost deal keeps its retired reason', async () => {
    const timing = await labelOf('Timing');
    asRole('salesA', 'sales');

    const unknownId = await seedOpportunity();
    const unknownRes = await markOpportunityLost(unknownId, 1, { lostReasonId: randomUUID() });
    expect(unknownRes.status).toBe(400);
    expect(errorOf(unknownRes.body).message).toMatch(/Unknown lost reason/);
    expect((await getOpportunity(unknownId)).stage).toBe('negotiation');

    // Mark one deal lost with Timing before retiring Timing.
    const existingId = await seedOpportunity();
    expect((await markOpportunityLost(existingId, 1, { lostReasonId: timing.id })).status).toBe(
      200,
    );

    asRole('boss', 'founder');
    const retire = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${timing.id}`)
      .send({ retired: true, expectedVersion: timing.version });
    expect(retire.status, JSON.stringify(retire.body)).toBe(200);
    const retiredVersion = LeadLostReasonSchema.parse(retire.body).version;

    // Existing deal still shows Timing marked retired on both get and list.
    asRole('salesA', 'sales');
    expect((await getOpportunity(existingId)).lostReason).toEqual({
      id: timing.id,
      label: 'Timing',
      retired: true,
    });
    const listed = OpportunityDtoSchema.array().parse(
      (await request(baseUrl).get('/v1/opportunities?limit=200')).body,
    );
    expect(listed.find((o) => o.id === existingId)?.lostReason).toEqual({
      id: timing.id,
      label: 'Timing',
      retired: true,
    });

    // A new opportunity cannot pick the retired option.
    const freshId = await seedOpportunity();
    const retiredRes = await markOpportunityLost(freshId, 1, { lostReasonId: timing.id });
    expect(retiredRes.status).toBe(400);
    expect(errorOf(retiredRes.body).message).toMatch(/no longer offered/);
    expect((await getOpportunity(freshId)).stage).toBe('negotiation');

    // Restore Timing so later tests see all defaults active.
    asRole('boss', 'founder');
    const restore = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${timing.id}`)
      .send({ retired: false, expectedVersion: retiredVersion });
    expect(restore.status).toBe(200);
  });

  it('adds a typed new reason to the shared list, offers it on leads too, and refuses duplicates (409) with the leads message', async () => {
    const oppId = await seedOpportunity();
    const res = await markOpportunityLost(oppId, 1, { newLostReason: '  Missing ERP sync  ' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const lost = oppDto(res.body);
    expect(lost.stageReason).toBe('Missing ERP sync');
    expect(lost.lostReason).toMatchObject({ label: 'Missing ERP sync', retired: false });
    const createdId = lost.lostReason!.id;

    // The newly added option is offered on BOTH opportunity and lead choices endpoints.
    const oppChoices = optionsSchema.parse(
      (await request(baseUrl).get('/v1/opportunity-lost-reasons')).body,
    );
    expect(oppChoices.find((o) => o.id === createdId)).toMatchObject({
      label: 'Missing ERP sync',
      isDefault: false,
    });

    const leadChoices = optionsSchema.parse(
      (await request(baseUrl).get('/v1/lead-lost-reasons')).body,
    );
    expect(leadChoices.find((o) => o.id === createdId)).toMatchObject({
      label: 'Missing ERP sync',
      isDefault: false,
    });

    // A lead can be marked lost with the exact option created from the opportunity dialog.
    const lead = await seedLead();
    const leadLost = await request(baseUrl).patch(`/v1/leads/${lead.id}/stage`).send({
      stage: 'lost',
      lostReasonId: createdId,
      note: 'Same reason on lead',
      expectedVersion: lead.version,
    });
    expect(leadLost.status, JSON.stringify(leadLost.body)).toBe(200);
    expect(leadDto(leadLost.body).lostReason).toEqual({
      id: createdId,
      label: 'Missing ERP sync',
      retired: false,
    });

    // Duplicate typed reason (case/spacing insensitive) gets 409 with the leads' message and leaves the deal unchanged.
    const dupOpp = await seedOpportunity();
    for (const typed of ['price', ' PRICE ', '  missing erp sync ']) {
      const dup = await markOpportunityLost(dupOpp, 1, { newLostReason: typed });
      expect(dup.status, typed).toBe(409);
      expect(errorOf(dup.body).message).toBe(
        `"${typed.trim()}" is already on the list of lost reasons`,
      );
    }
    expect(await getOpportunity(dupOpp)).toMatchObject({
      stage: 'negotiation',
      lostReason: null,
      version: 1,
    });
    const priceRows = await h.db.select().from(leadLostReasons);
    expect(
      priceRows.filter((r) => r.tenantId === h.tenantId && r.labelNorm === 'price'),
    ).toHaveLength(1);
  });

  it('shows a renamed option on an already-lost opportunity', async () => {
    const competitor = await labelOf('Chose a competitor');
    asRole('salesA', 'sales');
    const id = await seedOpportunity();
    expect((await markOpportunityLost(id, 1, { lostReasonId: competitor.id })).status).toBe(200);

    asRole('boss', 'founder');
    const renamed = await request(baseUrl)
      .patch(`/v1/admin/lead-lost-reasons/${competitor.id}`)
      .send({ label: 'Went with a rival', expectedVersion: competitor.version });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);

    asRole('salesA', 'sales');
    const after = await getOpportunity(id);
    expect(after.lostReason).toEqual({
      id: competitor.id,
      label: 'Went with a rival',
      retired: false,
    });
    // The snapshot words stay as recorded when the deal was lost.
    expect(after.stageReason).toBe('Chose a competitor');
  });

  it('clears lost_reason_id when leaving lost and on a system move', async () => {
    const price = await labelOf('Price');
    asRole('salesA', 'sales');
    const id = await seedOpportunity();
    expect((await markOpportunityLost(id, 1, { lostReasonId: price.id })).status).toBe(200);

    // Reopening from lost (manager edge) clears lostReasonId, stageReason and stageNote.
    const reopened = await opportunitiesService.changeStage(
      id,
      { stage: 'qualified', expectedVersion: 2 },
      'manager',
    );
    expect(reopened).toMatchObject({
      stage: 'qualified',
      stageReason: null,
      stageNote: null,
      lostReason: null,
      version: 3,
    });
    const [row] = await h.db.select().from(opportunities).where(eq(opportunities.id, id));
    expect(row).toMatchObject({ stage: 'qualified', lostReasonId: null });
    const stageEvents = (await auditRowsOf(id)).filter(
      (e) => e.action === 'opportunity.stage_changed',
    );
    expect(stageEvents.at(-1)?.meta).toMatchObject({ lostReasonId: null });

    // System move (markQuotationSent) also clears any lost_reason_id on the row.
    const sysId = await seedOpportunity('qualified');
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.opportunities SET lost_reason_id = ${price.id} WHERE id = ${sysId}`,
      ),
    );
    const moved = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      opportunitiesService.markQuotationSent(tx, sysId),
    );
    expect(moved).toMatchObject({ stage: 'quotation_sent', lostReason: null });
    const [sysRow] = await h.db.select().from(opportunities).where(eq(opportunities.id, sysId));
    expect(sysRow?.lostReasonId).toBeNull();
  });

  it('keeps the chosen option locked against a concurrent retire until the stage change commits', async () => {
    const price = await labelOf('Price');
    asRole('salesA', 'sales');
    const reasons = new LeadLostReasonsService(h.db, new AuditService(h.db), caller);
    const pgCode = (e: unknown) => {
      const err = e as { code?: string; cause?: { code?: string } } | null;
      return err?.code ?? err?.cause?.code;
    };
    // What update() and reset() need on the row; NOWAIT turns "would have to wait" into 55P03 without any sleep.
    const tryRowLock = () =>
      withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        tx.execute(
          sql`SELECT id FROM app.lead_lost_reasons WHERE id = ${price.id} FOR UPDATE NOWAIT`,
        ),
      );

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let chosenReady!: (picked: { id: string; label: string }) => void;
    const chosen = new Promise<{ id: string; label: string }>((resolve) => {
      chosenReady = resolve;
    });
    // The stage change's transaction: choose() has run, the commit has not.
    const stageChange = withTx(h.db, h.scopeA, systemActor('test'), async (tx) => {
      chosenReady(await reasons.choose(tx, h.tenantId, { lostReasonId: price.id }));
      await gate;
    });
    let held: unknown;
    try {
      // Race with stageChange so a failing choose() fails the test instead of hanging it.
      const picked = await Promise.race([chosen, stageChange.then(() => undefined)]);
      expect(picked).toEqual({ id: price.id, label: 'Price' });
      held = await tryRowLock().then(
        () => undefined,
        (e: unknown) => e,
      );
    } finally {
      release();
      await stageChange;
    }
    expect(pgCode(held), 'row lock attempted while the stage change is open').toBe('55P03');

    // Once the stage change has committed, a retire or reset can take the row again.
    await expect(tryRowLock()).resolves.toBeDefined();
  });

  it('serves GET /v1/opportunity-lost-reasons to a crm.opportunity.write caller without crm.lead.write', async () => {
    const reflector = new Reflector();
    expect(reflector.get(CAN_KEY, LeadLostReasonsController.prototype.opportunityChoices)).toBe(
      'crm.opportunity.write',
    );

    // A user with crm.opportunity.write ONLY (no crm.lead.write) can fetch opportunity choices, not lead choices.
    asGrants('salesA', { 'crm.opportunity.write': 'own' });
    const oppRes = await request(baseUrl).get('/v1/opportunity-lost-reasons');
    expect(oppRes.status, JSON.stringify(oppRes.body)).toBe(200);
    const list = optionsSchema.parse(oppRes.body);
    expect(list.every((o) => !o.retired)).toBe(true);
    expect(list.length).toBeGreaterThanOrEqual(DEFAULT_LEAD_LOST_REASONS.length);

    const leadRes = await request(baseUrl).get('/v1/lead-lost-reasons');
    expect(leadRes.status).toBe(403);

    // Without crm.opportunity.write, the opportunity choices route is refused (403).
    asGrants('viewer', { 'crm.opportunity.read': 'all' });
    expect((await request(baseUrl).get('/v1/opportunity-lost-reasons')).status).toBe(403);
  });
});
