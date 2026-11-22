// Integration tests of who may be handed a follow-up and what the assignment gives them (D50, K5, dead-ends #21
// and #22), on a real Postgres (Testcontainers, needs Docker in WSL). Real: migrations (the 0080 and 0088 triggers
// stamp each record's department), ActivitiesService, OpportunitiesService and the opportunity Owner filter,
// LeadsService (to make leads as their owner would), DraftingService (the quotation list and detail), the
// RoleCache with its level rows, the assignment rule with the entity's stored settings, NotifyService (bell and
// outbox rows), and the controllers behind the production body parser and error filter. Faked: the request
// context and authz.assert, which runs the real can() on a principal built like the tenancy interceptor's
// (../leads/test/harness.ts `actAs`).
// Run: pnpm --filter @bos/api exec vitest run src/modules/activities/activities.access.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ActivityDtoSchema,
  ErrorBodySchema,
  LeadDtoSchema,
  LeadOwnerOptionSchema,
  OpportunityDtoSchema,
} from '@bos/contracts';
import { leads, opportunities, quotations, users } from '@bos/db';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import { type AuthzService, scopeWhereFor } from '../../platform/authz/authz.service';
import { can } from '../../platform/authz/can';
import { systemActor, withTx } from '../../platform/db/tx';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import type { MoneyService } from '../../platform/settings/money.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsService } from '../leads/leads.service';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { OpportunitiesController } from '../opportunities/opportunities.controller';
import { OpportunitiesService } from '../opportunities/opportunities.service';
import { OpportunityOwnersService } from '../opportunities/opportunity-owners.service';
import { DraftingService } from '../quotations/drafting/drafting.service';
import { PricingService } from '../quotations/pricing/pricing.service';
import { quotationRef } from '../quotations/preview/quotation-preview.service';
import { drizzlePromiseStore } from '../receivables/promises/payment-promise.sweeper';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let service: ActivitiesService;
let leadsService: LeadsService;
let drafting: DraftingService;

/** The people of entity A, by what they do. Sales and Marketing are named so the default hand-over applies. */
const P = {
  sales: '',
  salesPeer: '',
  salesManager: '',
  marketer: '',
  storeKeeper: '',
};
let salesDepartment = '';

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const authz = h.authz as unknown as AuthzService;
  const audit = new AuditService(h.db);
  const reasons = new LeadLostReasonsService(h.db, audit, h.caller);
  leadsService = new LeadsService(
    h.db,
    authz,
    audit,
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    reasons,
    h.roleCache,
    h.notify,
  );
  service = new ActivitiesService(h.db, authz, audit, h.caller, h.roleCache, h.notify);
  const opportunitiesService = new OpportunitiesService(h.db, authz, audit, h.caller, reasons);
  // NPR only: pricing never asks for a rate here.
  const money = {
    toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
  } as unknown as MoneyService;
  drafting = new DraftingService(
    h.db,
    new NumberingService(),
    new PricingService(money),
    authz,
    audit,
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
  );

  salesDepartment = await h.department('Sales');
  const marketing = await h.department('Marketing');
  const warehouse = await h.department('Warehouse');
  P.sales = await h.member({
    roles: ['sales'],
    departmentId: salesDepartment,
    displayName: 'Sita Sales',
  });
  P.salesPeer = await h.member({
    roles: ['sales'],
    departmentId: salesDepartment,
    displayName: 'Ram Sales',
  });
  P.salesManager = await h.member({
    roles: ['sales'],
    departmentId: salesDepartment,
    level: 'manager',
    displayName: 'Maya Manager',
  });
  P.marketer = await h.member({
    roles: ['marketing'],
    departmentId: marketing,
    displayName: 'Mina Marketing',
  });
  P.storeKeeper = await h.member({ roles: ['warehouse'], departmentId: warehouse });

  const moduleRef = await Test.createTestingModule({
    controllers: [ActivitiesController, OpportunitiesController],
    providers: [
      { provide: ActivitiesService, useValue: service },
      { provide: OpportunitiesService, useValue: opportunitiesService },
      {
        provide: OpportunityOwnersService,
        useValue: new OpportunityOwnersService(h.db, h.caller, h.roleCache),
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

// ---------------------------------------------------------------------------------------- helpers

const DUE_1 = '2030-01-01T09:00:00.000Z';
const DUE_2 = '2030-01-02T09:00:00.000Z';
const LEAD_BODY = {
  title: 'Website for Acme',
  source: 'referral' as const,
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  country: 'NP' as const,
  currency: 'NPR' as const,
  phones: [{ country: 'NP' as const, e164: '+9779812345678', isPrimary: true }],
};

/** A lead created by `owner` through LeadsService, so its owner, creator and department are what a request sets. */
const leadOf = async (owner: string) => {
  await h.actAs(owner);
  return LeadDtoSchema.parse(await leadsService.create(LEAD_BODY));
};

const post = (body: Record<string, unknown>) => request(baseUrl).post('/v1/activities').send(body);
const patch = (id: string, action: 'complete' | 'reschedule' | 'cancel', body: unknown) =>
  request(baseUrl)
    .patch(`/v1/activities/${id}/${action}`)
    .send(body as object);
const get = (path: string) => request(baseUrl).get(path);
const dto = (body: unknown) => ActivityDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const listed = async (query: string) => {
  const res = await get(`/v1/activities${query}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return z.array(ActivityDtoSchema).parse(res.body);
};

/** A planned follow-up on `subject`, created by the current caller; asserts the 201. */
const plan = async (subject: Record<string, string>, assigneeUserId?: string) => {
  const res = await post({
    kind: 'call',
    subject: 'Call the buyer',
    dueAt: DUE_1,
    ...subject,
    ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
  });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dto(res.body);
};

/**
 * The code a refused create carries in `details.assignmentReason`, read from the service's exception: the HTTP
 * error filter passes `details` only for coded 409/422 answers today.
 */
const refusalOf = async (body: Record<string, unknown>): Promise<unknown> => {
  const error: unknown = await service.create(body as never).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(BadRequestException);
  return (
    (error as BadRequestException).getResponse() as { details?: { assignmentReason?: unknown } }
  ).details?.assignmentReason;
};

/** The `crm.assigned` bell and outbox rows of one follow-up, as the owner role sees them (no row security). */
const assignedNotices = async (activityId: string) => {
  const bell = await h.ownerPool.query(
    `SELECT user_id, link, dedupe_key FROM app.notifications
      WHERE tenant_id = $1 AND dedupe_key LIKE $2 ORDER BY id`,
    [h.tenantId, `crm.assigned:activity:${activityId}:%`],
  );
  const mail = await h.ownerPool.query(
    `SELECT template, to_user_id, dedupe_key FROM app.outbox
      WHERE tenant_id = $1 AND dedupe_key LIKE $2 ORDER BY id`,
    [h.tenantId, `crm.assigned:activity:${activityId}:%`],
  );
  return {
    bell: bell.rows as { user_id: string; link: string; dedupe_key: string }[],
    mail: mail.rows as { template: string; to_user_id: string; dedupe_key: string }[],
  };
};

let customerId: string | undefined;
/** An opportunity of entity A owned by `owner`; the 0080 trigger stamps the owner's department. */
const opportunityOf = async (owner: string): Promise<string> => {
  customerId ??= await h.seedCustomer();
  const [row] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...h.scopeA,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Acme website',
        customerId: customerId!,
        ownerUserId: owner,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
};

/**
 * A quotation on `opportunityId` owned by `owner`, with one Draft revision as its current version, written the way
 * DraftingService.create leaves it. The 0088 trigger copies the opportunity's department onto it.
 */
const quotationOf = async (opportunityId: string, owner: string): Promise<string> =>
  withTx(h.db, h.scopeA, systemActor('test'), async (tx) => {
    const quotation = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id,
                                      owner_user_id)
          VALUES (${h.tenantId}, ${h.scopeA.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`},
                  ${customerId!}, ${opportunityId}, ${owner})
          RETURNING id`,
    );
    const id = quotation.rows[0]!.id;
    const version = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotation_versions
            (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${h.tenantId}, ${h.scopeA.organizationId}, ${id}, 1, 'NPR', '2026-11-09', '2026-12-09')
          RETURNING id`,
    );
    await tx.execute(
      sql`UPDATE app.quotations SET current_version_id = ${version.rows[0]!.id} WHERE id = ${id}`,
    );
    return id;
  });

const departmentOf = async (table: typeof opportunities | typeof quotations, id: string) => {
  const [row] = await h.db
    .select({ departmentId: table.departmentId })
    .from(table)
    .where(eq(table.id, id));
  return row?.departmentId;
};

/** The current caller as the services see them. */
const principal = () => h.caller.current().principal;

// ------------------------------------------------------------------------------------------- tests

describe('a lead follow-up handed to a Sales peer (D50, K5)', () => {
  it('lets the assignee list it, read the lead through it and complete it, but not edit the lead or move it', async () => {
    const lead = await leadOf(P.sales);

    // Before the hand-over the peer's own reach does not cover the lead: the reach below comes from the follow-up.
    await h.actAs(P.salesPeer);
    expect((await get(`/v1/activities?leadId=${lead.id}`)).status).toBe(404);

    await h.actAs(P.sales);
    const followUp = await plan({ leadId: lead.id }, P.salesPeer);
    expect(followUp).toMatchObject({ assigneeUserId: P.salesPeer, createdByUserId: P.sales });

    await h.actAs(P.salesPeer);
    expect((await listed('?status=planned&limit=200')).map((a) => a.id)).toContain(followUp.id);
    expect((await listed(`?leadId=${lead.id}`)).map((a) => a.id)).toContain(followUp.id);
    // The lead list and the lead itself agree: assigned reach on crm.lead.read, read only.
    const readable = await h.db
      .select({ id: leads.id })
      .from(leads)
      .where(scopeWhereFor(principal(), leads, 'crm.lead.read'));
    expect(readable.map((r) => r.id)).toContain(lead.id);
    expect(LeadDtoSchema.parse(await leadsService.get(lead.id)).ownerUserId).toBe(P.sales);

    // Writing on the lead (an activity needs crm.lead.write on it) stays the owner's: out of reach is a 404.
    const note = await post({ kind: 'note', subject: 'Notes', leadId: lead.id });
    expect(note.status, JSON.stringify(note.body)).toBe(404);
    // Moving or calling off the follow-up needs lead write too; the assignee sees the row, so it is a 403.
    expect(
      (await patch(followUp.id, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status,
    ).toBe(403);
    expect((await patch(followUp.id, 'cancel', { expectedVersion: 1 })).status).toBe(403);

    const done = await patch(followUp.id, 'complete', {
      expectedVersion: 1,
      note: 'Spoke to them',
    });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(dto(done.body)).toMatchObject({ planned: false, version: 2 });

    // A peer who holds no assignment still cannot complete a colleague's follow-up.
    await h.actAs(P.sales);
    const other = await plan({ leadId: lead.id });
    await h.actAs(P.salesPeer);
    expect((await patch(other.id, 'complete', { expectedVersion: 1 })).status).toBe(404);
  });

  it('refuses someone who could not read the lead (cannot_read_subject), even from the Founder', async () => {
    const lead = await leadOf(P.sales);
    await h.actAs(h.users.boss);
    const body = { kind: 'call', subject: 'Count stock', dueAt: DUE_1, leadId: lead.id };
    const res = await post({ ...body, assigneeUserId: P.storeKeeper });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'bad_request',
      message: 'assigneeUserId cannot see the record this is about',
    });
    expect(await refusalOf({ ...body, assigneeUserId: P.storeKeeper })).toBe('cannot_read_subject');
    // Positive control: the same Founder may give it to a salesperson.
    expect((await post({ ...body, assigneeUserId: P.salesPeer })).status).toBe(201);
  });

  it('follows the rule across departments and levels: no Sales to Marketing or Warehouse, no upward, Marketing to Sales', async () => {
    const lead = await leadOf(P.sales);
    const body = { kind: 'call', subject: 'Hand over', dueAt: DUE_1, leadId: lead.id };
    const toMarketing = await post({ ...body, assigneeUserId: P.marketer });
    expect(toMarketing.status, JSON.stringify(toMarketing.body)).toBe(400);
    expect(errorOf(toMarketing.body).message).toBe(
      'assigneeUserId cannot be a Marketing user: leads are handed from Marketing to Sales, not back',
    );
    expect(await refusalOf({ ...body, assigneeUserId: P.marketer })).toBe('reverse_handoff');
    // No stored hand-over runs from Sales to Warehouse: the rule refuses before the read check is reached.
    const toWarehouse = await post({ ...body, assigneeUserId: P.storeKeeper });
    expect(toWarehouse.status, JSON.stringify(toWarehouse.body)).toBe(400);
    expect(errorOf(toWarehouse.body).message).toBe('assigneeUserId is outside your department');
    expect(await refusalOf({ ...body, assigneeUserId: P.storeKeeper })).toBe('other_department');

    const upward = await post({ ...body, assigneeUserId: P.salesManager });
    expect(upward.status, JSON.stringify(upward.body)).toBe(400);
    expect(errorOf(upward.body).message).toBe(
      'assigneeUserId cannot be someone more senior than you',
    );

    const marketingLead = await leadOf(P.marketer);
    const handed = await plan({ leadId: marketingLead.id }, P.sales);
    expect(handed.assigneeUserId).toBe(P.sales);
    await h.actAs(P.sales);
    expect((await listed(`?leadId=${marketingLead.id}`)).map((a) => a.id)).toContain(handed.id);
  });
});

describe('a customer follow-up handed to an own reader (U20a2-Q7)', () => {
  it('lets the assignee list and complete it without reaching the customer, and nothing more', async () => {
    const customer = await h.seedCustomer(P.sales);
    await h.actAs(P.sales);
    const followUp = await plan({ customerId: customer }, P.marketer);
    const other = await plan({ customerId: customer });

    // Marketing reads only the customers it owns: this one is outside its reach.
    await h.actAs(P.marketer);
    expect((await get(`/v1/activities?customerId=${customer}`)).status).toBe(404);
    expect((await listed('?status=planned&limit=200')).map((a) => a.id)).toContain(followUp.id);
    // Moving or calling it off still needs the customer, as before.
    expect(
      (await patch(followUp.id, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status,
    ).toBe(404);
    expect((await patch(followUp.id, 'cancel', { expectedVersion: 1 })).status).toBe(404);
    // A follow-up on the same customer that is not theirs is still refused (Marketing holds no customer write).
    expect((await patch(other.id, 'complete', { expectedVersion: 1 })).status).toBe(403);

    const done = await patch(followUp.id, 'complete', { expectedVersion: 1, note: 'Sent it' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(dto(done.body)).toMatchObject({ id: followUp.id, planned: false, version: 2 });
    expect((await get(`/v1/activities?customerId=${customer}`)).status).toBe(404);
  });
});

describe('a manager and the crm.assigned notice (#22)', () => {
  it('lets a Sales manager reschedule a department member follow-up and hand it on, telling the new assignee', async () => {
    const lead = await leadOf(P.sales);
    const own = await plan({ leadId: lead.id });
    expect(own.assigneeUserId).toBe(P.sales);

    await h.actAs(P.salesManager);
    const moved = await patch(own.id, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const handed = await patch(own.id, 'reschedule', {
      expectedVersion: 2,
      dueAt: DUE_2,
      assigneeUserId: P.salesPeer,
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(200);
    expect(dto(handed.body)).toMatchObject({ assigneeUserId: P.salesPeer, version: 3 });

    const notices = await assignedNotices(own.id);
    expect(notices.bell).toEqual([
      {
        user_id: P.salesPeer,
        link: `/leads/${lead.id}`,
        dedupe_key: `crm.assigned:activity:${own.id}:3`,
      },
    ]);
    expect(notices.mail).toEqual([
      {
        template: 'crm.assigned',
        to_user_id: P.salesPeer,
        dedupe_key: `crm.assigned:activity:${own.id}:3:${P.salesPeer}`,
      },
    ]);
  });

  it('notifies on a follow-up planned for someone else, and not for the caller or a logged activity', async () => {
    const lead = await leadOf(P.sales);
    const forPeer = await plan({ leadId: lead.id }, P.salesPeer);
    const forMe = await plan({ leadId: lead.id }, P.sales);
    const byDefault = await plan({ leadId: lead.id });
    const logged = await post({
      kind: 'note',
      subject: 'Met them',
      leadId: lead.id,
      assigneeUserId: P.salesPeer,
    });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);

    const peerNotices = await assignedNotices(forPeer.id);
    expect(peerNotices.bell.map((n) => n.user_id)).toEqual([P.salesPeer]);
    expect(peerNotices.mail.map((n) => [n.template, n.to_user_id])).toEqual([
      ['crm.assigned', P.salesPeer],
    ]);
    for (const quiet of [forMe.id, byDefault.id, dto(logged.body).id]) {
      expect(await assignedNotices(quiet), quiet).toEqual({ bell: [], mail: [] });
    }
  });
});

describe('opportunities and quotations', () => {
  it('gives an opportunity follow-up to its owner by default and lets the assignee read, not change, the deal', async () => {
    const deal = await opportunityOf(P.sales);
    expect(await departmentOf(opportunities, deal)).toBe(salesDepartment);

    await h.actAs(h.users.boss);
    const byFounder = await plan({ opportunityId: deal });
    expect(byFounder.assigneeUserId).toBe(P.sales);

    await h.actAs(P.salesPeer);
    expect((await get(`/v1/opportunities/${deal}`)).status).toBe(404);

    await h.actAs(P.sales);
    await plan({ opportunityId: deal }, P.salesPeer);

    await h.actAs(P.salesPeer);
    const opened = await get(`/v1/opportunities/${deal}`);
    expect(opened.status, JSON.stringify(opened.body)).toBe(200);
    expect(OpportunityDtoSchema.parse(opened.body).ownerUserId).toBe(P.sales);
    const listedDeals = z
      .array(OpportunityDtoSchema)
      .parse((await get('/v1/opportunities?limit=200')).body);
    expect(listedDeals.map((o) => o.id)).toContain(deal);
    const stage = await request(baseUrl)
      .patch(`/v1/opportunities/${deal}/stage`)
      .send({ stage: 'requirement_received', expectedVersion: 1 });
    expect(stage.status, JSON.stringify(stage.body)).toBe(404);
  });

  it('lets a Sales manager reach a department colleague deal and quotation, list and record alike, and not a peer', async () => {
    const deal = await opportunityOf(P.sales);
    const quotation = await quotationOf(deal, P.sales);
    expect(await departmentOf(quotations, quotation)).toBe(salesDepartment);
    const [row] = await h.db.select().from(quotations).where(eq(quotations.id, quotation));

    await h.actAs(P.salesManager);
    expect((await get(`/v1/opportunities/${deal}`)).status).toBe(200);
    expect((await get(`/v1/activities?opportunityId=${deal}`)).status).toBe(200);
    expect((await get(`/v1/activities?quotationId=${quotation}`)).status).toBe(200);
    expect(can(principal(), 'quotation.read', quotationRef(row!)).allowed).toBe(true);
    expect((await drafting.list()).rows.map((q) => q.id)).toContain(quotation);
    expect((await drafting.detail(quotation)).quotation.id).toBe(quotation);

    await h.actAs(P.salesPeer);
    expect((await get(`/v1/opportunities/${deal}`)).status).toBe(404);
    expect((await get(`/v1/activities?quotationId=${quotation}`)).status).toBe(404);
    expect(can(principal(), 'quotation.read', quotationRef(row!)).allowed).toBe(false);
    expect((await drafting.list()).rows.map((q) => q.id)).not.toContain(quotation);
    await expect(drafting.detail(quotation)).rejects.toMatchObject({ status: 404 });
  });

  it('offers the Owner filter the owners of readable deals and the people the viewer may hand work to', async () => {
    await opportunityOf(P.salesPeer);
    await opportunityOf(P.salesManager);
    await h.actAs(P.salesPeer);
    const res = await get('/v1/opportunities/owner-filter');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const people = z.array(LeadOwnerOptionSchema).parse(res.body);
    const ids = people.map((p) => p.userId);
    // Own deal and a same-level peer they may hand work to; never the manager above them, whose deal they cannot read.
    expect(ids).toEqual(expect.arrayContaining([P.salesPeer, P.sales]));
    expect(ids).not.toContain(P.salesManager);
    expect(ids).not.toContain(P.marketer);
    expect(people.every((p) => p.email === '')).toBe(true);
    expect(people.find((p) => p.userId === P.sales)?.displayName).toBe('Sita Sales');

    // The manager reads the department's deals, so both owners are offered.
    await h.actAs(P.salesManager);
    const managerIds = z
      .array(LeadOwnerOptionSchema)
      .parse((await get('/v1/opportunities/owner-filter')).body)
      .map((p) => p.userId);
    expect(managerIds).toEqual(expect.arrayContaining([P.salesPeer, P.salesManager]));
  });

  it('shows an owner without a display name as Unnamed user, never part of the address', async () => {
    const nameless = await h.member({ roles: ['sales'], departmentId: salesDepartment });
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .update(users)
        .set({ displayName: null, email: 'hidden.person@crestia.example' })
        .where(eq(users.id, nameless)),
    );
    await opportunityOf(nameless);
    await h.actAs(P.salesManager);
    const people = z
      .array(LeadOwnerOptionSchema)
      .parse((await get('/v1/opportunities/owner-filter')).body);
    expect(people.find((p) => p.userId === nameless)?.displayName).toBe('Unnamed user');
    expect(JSON.stringify(people)).not.toMatch(/hidden\.person/);
  });
});

describe('a collection call (R4c1 Q1: the receivables permissions, not the customer reach)', () => {
  /** A collection call on `customer`, written by the payment-promise job's own store (the real producer). */
  const collectionCall = (customer: string, assigneeUserId: string | null): Promise<string> =>
    withTx(h.db, h.scopeA, systemActor('payment-promise'), (tx) =>
      drizzlePromiseStore(h.db).planCall(
        tx,
        { ...h.scopeA, promiseId: randomUUID() },
        {
          customerPartyId: customer,
          subject: 'Collect payment for INV-1',
          body: 'The customer promised to pay INV-1 by 2030-01-01, and it is still open.',
          dueAt: new Date(DUE_1),
          assigneeUserId,
        },
      ),
    );

  it('hides it from the Sales owner of the customer and lets the Finance assignee list and complete it', async () => {
    const finance = await h.member({ roles: ['finance'], displayName: 'Fina Finance' });
    const manager = await h.member({ roles: ['management'], displayName: 'Mona Management' });
    const customer = await h.seedCustomer(P.sales);
    const callId = await collectionCall(customer, finance);

    // The Sales owner reads the customer and its other activities, never the call about its money.
    await h.actAs(P.sales);
    const salesCall = await plan({ customerId: customer });
    const onCustomer = (await listed(`?customerId=${customer}&limit=200`)).map((a) => a.id);
    expect(onCustomer).toContain(salesCall.id);
    expect(onCustomer).not.toContain(callId);
    expect((await listed('?status=planned&limit=200')).map((a) => a.id)).not.toContain(callId);
    expect((await patch(callId, 'cancel', { expectedVersion: 1 })).status).toBe(404);
    expect((await patch(callId, 'complete', { expectedVersion: 1 })).status).toBe(404);
    expect((await patch(callId, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status).toBe(
      404,
    );

    // Management reads receivables but records no payment: it sees the call and may not change it.
    await h.actAs(manager);
    expect((await listed('?status=planned&limit=200')).map((a) => a.id)).toContain(callId);
    expect((await patch(callId, 'cancel', { expectedVersion: 1 })).status).toBe(403);

    // The Finance assignee finds it on the Follow-ups list and completes it.
    await h.actAs(finance);
    const planned = await listed('?status=planned&limit=200');
    expect(planned.find((a) => a.id === callId)).toMatchObject({
      kind: 'collection_call',
      planned: true,
      customerId: customer,
      assigneeUserId: finance,
      assigneeName: 'Fina Finance',
    });
    const done = await patch(callId, 'complete', { expectedVersion: 1, note: 'Pays on Friday' });
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(dto(done.body)).toMatchObject({ id: callId, planned: false, version: 2 });
    expect((await listed('?status=logged&limit=200')).map((a) => a.id)).toContain(callId);

    // Done, it stays out of the Sales owner's customer history too.
    await h.actAs(P.sales);
    expect(
      (await listed(`?customerId=${customer}&status=logged&limit=200`)).map((a) => a.id),
    ).not.toContain(callId);
  });

  it("reports the list's can flags by the same rule its routes enforce", async () => {
    const finance = await h.member({ roles: ['finance'], displayName: 'Faye Finance' });
    const financePeer = await h.member({ roles: ['finance'], displayName: 'Fern Finance' });
    const manager = await h.member({ roles: ['management'], displayName: 'Mira Management' });
    const customer = await h.seedCustomer(P.sales);
    const ALL = { complete: true, reschedule: true, cancel: true };
    const NONE = { complete: false, reschedule: false, cancel: false };
    const flagsOf = async (callId: string) =>
      (await listed('?status=planned&limit=200')).find((a) => a.id === callId)?.can;

    // Finance, assignee or not, gets every action from ar.read and payment.record; the routes then allow each.
    const assigned = await collectionCall(customer, finance);
    await h.actAs(finance);
    expect(await flagsOf(assigned)).toEqual(ALL);
    const moved = await patch(assigned, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const done = await patch(assigned, 'complete', { expectedVersion: 2 });
    expect(done.status, JSON.stringify(done.body)).toBe(200);

    const covered = await collectionCall(customer, finance);
    await h.actAs(financePeer);
    expect(await flagsOf(covered)).toEqual(ALL);
    const cancelled = await patch(covered, 'cancel', { expectedVersion: 1 });
    expect(cancelled.status, JSON.stringify(cancelled.body)).toBe(200);

    // Management reads receivables but records no payment: listed with no action, and each route is a 403.
    const watched = await collectionCall(customer, finance);
    await h.actAs(manager);
    expect(await flagsOf(watched)).toEqual(NONE);
    expect((await patch(watched, 'complete', { expectedVersion: 1 })).status).toBe(403);
    expect((await patch(watched, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status).toBe(
      403,
    );
    expect((await patch(watched, 'cancel', { expectedVersion: 1 })).status).toBe(403);

    // The customer's Sales owner, even as the assignee, never lists it and each route is a 404.
    const salesCall = await collectionCall(customer, P.sales);
    await h.actAs(P.sales);
    for (const callId of [watched, salesCall]) {
      expect((await listed('?status=planned&limit=200')).map((a) => a.id)).not.toContain(callId);
      expect((await listed(`?customerId=${customer}&limit=200`)).map((a) => a.id)).not.toContain(
        callId,
      );
      expect((await patch(callId, 'complete', { expectedVersion: 1 })).status).toBe(404);
      expect((await patch(callId, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status).toBe(
        404,
      );
      expect((await patch(callId, 'cancel', { expectedVersion: 1 })).status).toBe(404);
    }
  });

  it('moves it only to someone who records payments', async () => {
    const finance = await h.member({ roles: ['finance'], displayName: 'Fred Finance' });
    const accountant = await h.member({ roles: ['accountant'], displayName: 'Anu Accountant' });
    const customer = await h.seedCustomer(P.sales);
    const callId = await collectionCall(customer, finance);

    await h.actAs(finance);
    const toSales = await patch(callId, 'reschedule', {
      expectedVersion: 1,
      dueAt: DUE_2,
      assigneeUserId: P.sales,
    });
    expect(toSales.status, JSON.stringify(toSales.body)).toBe(400);
    const toAccountant = await patch(callId, 'reschedule', {
      expectedVersion: 1,
      dueAt: DUE_2,
      assigneeUserId: accountant,
    });
    expect(toAccountant.status, JSON.stringify(toAccountant.body)).toBe(200);
    expect(dto(toAccountant.body)).toMatchObject({ assigneeUserId: accountant, dueAt: DUE_2 });
  });
});
