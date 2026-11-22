// Integration tests of the activities API on a real Postgres (Testcontainers, needs Docker in WSL). Real:
// migrations, ActivitiesService, LeadsService (to make lead subjects), NumberingService, AuditService, the
// RoleCache and NotifyService, and the controller behind the production body parser and error filter. Faked: the
// request context and authz.assert (see ../leads/test/harness.ts). Responses are parsed with the contract schema
// the workspace uses. The D50 assignment rule, assigned reach and `crm.assigned` are in
// activities.access.integration.test.ts.
// Run: pnpm --filter @bos/api exec vitest run src/modules/activities
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ActivityDtoSchema, ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { activities, createParty, createPortalUser, createStaffUser, leads, users } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { systemActor, withTx } from '../../platform/db/tx';
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsService } from '../leads/leads.service';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';
import { nextFollowUpSql } from './activities.types';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let leadsService: LeadsService;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const authz = h.authz as unknown as AuthzService;
  leadsService = new LeadsService(
    h.db,
    authz,
    new AuditService(h.db),
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, new AuditService(h.db), h.caller),
    h.roleCache,
    h.notify,
  );
  const service = new ActivitiesService(
    h.db,
    authz,
    new AuditService(h.db),
    h.caller,
    h.roleCache,
    h.notify,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [ActivitiesController],
    providers: [{ provide: ActivitiesService, useValue: service }],
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
  h.as('salesA', 'sales');
});

const LEAD_BODY = {
  title: 'Website for Acme',
  source: 'referral' as const,
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  country: 'NP' as const,
  currency: 'NPR' as const,
  phones: [{ country: 'NP' as const, e164: '+9779812345678', isPrimary: true }],
};
/** A lead of the current acting user and entity. */
const seedLead = async () => LeadDtoSchema.parse(await leadsService.create(LEAD_BODY));

const post = (body: Record<string, unknown>, key?: string) => {
  const req = request(baseUrl).post('/v1/activities');
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};
const list = (query: string) => request(baseUrl).get(`/v1/activities${query}`);
const dto = (body: unknown) => ActivityDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const listed = async (query: string) => {
  const res = await list(query);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return z.array(ActivityDtoSchema).parse(res.body);
};
/** Stands in for the complete and cancel routes (another unit): sets the column on the row directly. */
const setOnRow = (id: string, set: { completedAt?: Date; cancelledAt?: Date }) =>
  withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.update(activities).set(set).where(eq(activities.id, id)),
  );
/** An inactive staff member and a customer portal user of this tenant, made once. */
let outsidersMade: { inactive: string; portal: string } | undefined;
const outsiders = async () => {
  if (outsidersMade !== undefined) return outsidersMade;
  const pool = h.appPool as unknown as Parameters<typeof createParty>[0];
  const [staff] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.select({ idpOrgId: users.idpOrgId }).from(users).where(eq(users.id, h.users.salesA)),
  );
  const { userId: inactive } = await createStaffUser(pool, {
    ...h.scopeA,
    idpOrgId: staff!.idpOrgId,
  });
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.update(users).set({ status: 'inactive' }).where(eq(users.id, inactive)),
  );
  const party = await createParty(pool, { tenantId: h.tenantId, kind: 'customer' });
  const { userId: portal } = await createPortalUser(pool, {
    tenantId: h.tenantId,
    idpOrgId: party.idpOrgId,
  });
  outsidersMade = { inactive, portal };
  return outsidersMade;
};
const DUE_1 = '2030-01-01T09:00:00.000Z';
const DUE_2 = '2030-01-02T09:00:00.000Z';
const DUE_3 = '2030-01-03T09:00:00.000Z';

describe('POST /v1/activities', () => {
  it('logs a call on a lead the caller owns, audits it, and replays an Idempotency-Key', async () => {
    const lead = await seedLead();
    const key = `act-${Date.now()}`;
    const body = { kind: 'call', subject: 'Intro call', body: 'Went well', leadId: lead.id };
    const res = await post(body, key);
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(dto(res.body)).toMatchObject({ kind: 'call', leadId: lead.id, opportunityId: null });
    expect((await h.auditOf(dto(res.body).id)).map((e) => e.action)).toContain('activity.created');

    const again = await post(body, key);
    expect(again.body).toEqual(res.body);
    const rows = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(rows.filter((r) => r.kind === 'call')).toHaveLength(1);
  });

  it('answers 400 for two subjects, none, or a kind only the server writes', async () => {
    const lead = await seedLead();
    const customer = await h.seedCustomer();
    const base = { kind: 'note', subject: 'x' };
    for (const body of [
      { ...base, leadId: lead.id, customerId: customer },
      base,
      { ...base, kind: 'stage_change', leadId: lead.id },
    ]) {
      const res = await post(body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });

  it('is refused by the database too when two subjects get past the code', async () => {
    const lead = await seedLead();
    const customer = await h.seedCustomer();
    // Through withTx so the audit trigger has an actor; the CHECK is what must refuse the row.
    await expect(
      withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        tx.insert(activities).values({
          ...h.scopeA,
          kind: 'note',
          subject: 'x',
          leadId: lead.id,
          customerId: customer,
        }),
      ),
    ).rejects.toMatchObject({ cause: { constraint: 'activities_one_subject_check' } });
  });

  it('answers 404 for a subject in another entity or of a colleague, 403 for a read-only role', async () => {
    h.as('salesB', 'sales');
    const colleague = await seedLead();
    h.as('salesB', 'sales', 'B');
    const otherEntity = await seedLead();

    h.as('salesA', 'sales');
    for (const leadId of [colleague.id, otherEntity.id]) {
      const res = await post({ kind: 'note', subject: 'x', leadId });
      expect(res.status, leadId).toBe(404);
      expect(errorOf(res.body).code).toBe('not_found');
    }
    const mine = await seedLead();
    h.as('viewer', 'management');
    expect((await post({ kind: 'note', subject: 'x', leadId: mine.id })).status).toBe(403);
  });

  it('takes the permission of the subject: a customer activity needs customer.write', async () => {
    const customer = await h.seedCustomer(h.users.boss);
    h.as('salesA', 'sales');
    const ok = await post({ kind: 'meeting', subject: 'Site visit', customerId: customer });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    h.as('viewer', 'management');
    expect(
      (await post({ kind: 'meeting', subject: 'Site visit', customerId: customer })).status,
    ).toBe(403);
  });
});

describe('GET /v1/activities', () => {
  it('lists the activities of one subject as a bare array, filtered by kind, and 404s a foreign subject', async () => {
    const lead = await seedLead();
    await post({ kind: 'call', subject: 'A', leadId: lead.id });
    await post({ kind: 'note', subject: 'B', leadId: lead.id });

    const all = z.array(ActivityDtoSchema).parse((await list(`?leadId=${lead.id}`)).body);
    expect(all.map((a) => a.subject).sort()).toEqual(['A', 'B']);
    const calls = z
      .array(ActivityDtoSchema)
      .parse((await list(`?leadId=${lead.id}&kind=call`)).body);
    expect(calls.map((a) => a.subject)).toEqual(['A']);

    h.as('salesB', 'sales', 'B');
    expect((await list(`?leadId=${lead.id}`)).status).toBe(404);
    expect((await list(`?leadId=${lead.id}&customerId=${lead.id}`)).status).toBe(400);
  });

  it('without a subject returns only activities whose subject the caller may read', async () => {
    h.as('salesA', 'sales');
    const mine = await seedLead();
    await post({ kind: 'note', subject: 'mine-visible', leadId: mine.id });
    h.as('salesB', 'sales');
    const theirs = await seedLead();
    await post({ kind: 'note', subject: 'theirs-hidden', leadId: theirs.id });
    h.as('salesB', 'sales', 'B');
    const other = await seedLead();
    await post({ kind: 'note', subject: 'entity-b-hidden', leadId: other.id });

    h.as('salesA', 'sales');
    const seen = z.array(ActivityDtoSchema).parse((await list('?limit=200')).body);
    const subjects = seen.map((a) => a.subject);
    expect(subjects).toContain('mine-visible');
    // `own` scope on leads: a colleague's lead activity is out, and so is another entity's.
    expect(subjects).not.toContain('theirs-hidden');
    expect(subjects).not.toContain('entity-b-hidden');

    h.as('boss', 'founder');
    const bossSees = z
      .array(ActivityDtoSchema)
      .parse((await list('?limit=200')).body)
      .map((a) => a.subject);
    expect(bossSees).toEqual(expect.arrayContaining(['mine-visible', 'theirs-hidden']));
    expect(bossSees).not.toContain('entity-b-hidden');
  });

  it('filters by repeated kind and by a search over subject and body, with a total header', async () => {
    const lead = await seedLead();
    await post({ kind: 'call', subject: 'Quokka intro', leadId: lead.id });
    await post({
      kind: 'note',
      subject: 'Plain',
      body: 'about the quokka rollout',
      leadId: lead.id,
    });
    await post({ kind: 'email', subject: 'Quokka mail', leadId: lead.id });
    await post({ kind: 'meeting', subject: 'Unrelated', leadId: lead.id });

    const get = async (query: string) => {
      const res = await list(query);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return {
        subjects: z
          .array(ActivityDtoSchema)
          .parse(res.body)
          .map((a) => a.subject)
          .sort(),
        total: res.headers['x-total-count'],
      };
    };
    expect(await get('?q=quokka')).toEqual({
      subjects: ['Plain', 'Quokka intro', 'Quokka mail'],
      total: '3',
    });
    expect(await get('?q=quokka&kind=call&kind=note')).toEqual({
      subjects: ['Plain', 'Quokka intro'],
      total: '2',
    });
    expect(await get(`?leadId=${lead.id}&limit=1&offset=3`)).toMatchObject({ total: '4' });
  });

  it('keeps the readable-subject scope when searching and finds a close spelling', async () => {
    h.as('salesB', 'sales');
    const theirs = await seedLead();
    await post({ kind: 'note', subject: 'Himalyan secret', leadId: theirs.id });
    h.as('salesA', 'sales');
    const mine = await seedLead();
    await post({ kind: 'note', subject: 'Himalyan Traders visit', leadId: mine.id });

    const res = await list('?q=Himalayan');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const subjects = z
      .array(ActivityDtoSchema)
      .parse(res.body)
      .map((a) => a.subject);
    expect(subjects).toContain('Himalyan Traders visit');
    expect(subjects).not.toContain('Himalyan secret');
    expect(res.headers['x-total-count']).toBe(String(subjects.length));
  });

  it('refuses an unknown kind, an unknown param and a negative offset with 400', async () => {
    for (const query of ['?kind=nonsense', '?color=red', '?offset=-1', '?q=ab&q=cd']) {
      expect((await list(query)).status, query).toBe(400);
    }
  });
});

describe('planned and logged activities', () => {
  it('plans an activity with a due time: assignee defaults to the lead owner, creator is the caller, audited as scheduled', async () => {
    const lead = await seedLead(); // owned by salesA
    h.as('boss', 'founder');
    const res = await post({ kind: 'call', subject: 'Chase', dueAt: DUE_1, leadId: lead.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const planned = dto(res.body);
    expect(planned).toMatchObject({
      planned: true,
      dueAt: DUE_1,
      completedAt: null,
      cancelledAt: null,
      assigneeUserId: h.users.salesA,
      createdByUserId: h.users.boss,
      version: 1,
    });
    const actions = (await h.auditOf(planned.id)).map((e) => e.action);
    expect(actions).toContain('activity.scheduled');
    expect(actions).not.toContain('activity.created');

    const logged = dto((await post({ kind: 'note', subject: 'Called', leadId: lead.id })).body);
    expect(logged).toMatchObject({
      planned: false,
      dueAt: null,
      assigneeUserId: null,
      createdByUserId: h.users.boss,
    });
    expect((await h.auditOf(logged.id)).map((e) => e.action)).toContain('activity.created');
  });

  it('assigns a planned activity on another subject to the caller; an explicit assignee wins', async () => {
    const customer = await h.seedCustomer(h.users.boss);
    h.as('salesA', 'sales');
    const mine = dto(
      (await post({ kind: 'meeting', subject: 'Visit', dueAt: DUE_1, customerId: customer })).body,
    );
    expect(mine).toMatchObject({ planned: true, assigneeUserId: h.users.salesA });
    // Not a lead: any active staff member of the entity may be named.
    const colleague = dto(
      (
        await post({
          kind: 'meeting',
          subject: 'Visit too',
          dueAt: DUE_1,
          assigneeUserId: h.users.salesB,
          customerId: customer,
        })
      ).body,
    );
    expect(colleague).toMatchObject({ assigneeUserId: h.users.salesB });

    const lead = await seedLead();
    const send = () =>
      post({
        kind: 'email',
        subject: 'Send deck',
        dueAt: DUE_2,
        assigneeUserId: h.users.salesB,
        leadId: lead.id,
      });
    // On a lead, the assignment rule decides (D50): two salespeople with no department share no team to hand
    // work within.
    const refused = await send();
    expect(refused.status, JSON.stringify(refused.body)).toBe(400);
    expect(errorOf(refused.body)).toMatchObject({
      code: 'bad_request',
      message: 'assigneeUserId needs you and them to belong to a department',
    });
    h.as('boss', 'founder');
    const explicit = dto((await send()).body);
    expect(explicit).toMatchObject({
      assigneeUserId: h.users.salesB,
      createdByUserId: h.users.boss,
    });
  });

  it('refuses an assignee who is not an active staff member of the entity with 400', async () => {
    const { inactive, portal } = await outsiders();
    const lead = await seedLead();
    const customer = await h.seedCustomer(h.users.boss);
    h.as('boss', 'founder');
    for (const assigneeUserId of [inactive, portal, crypto.randomUUID()]) {
      for (const subject of [{ leadId: lead.id }, { customerId: customer }]) {
        const res = await post({
          kind: 'call',
          subject: 'x',
          dueAt: DUE_1,
          assigneeUserId,
          ...subject,
        });
        expect(res.status, JSON.stringify(res.body)).toBe(400);
        expect(errorOf(res.body).message).toBe(
          'assigneeUserId is not an active staff member of this entity',
        );
      }
    }
  });

  it('filters by status: planned earliest first, logged newest first, cancelled never; scope unchanged', async () => {
    const lead = await seedLead();
    const make = async (body: Record<string, unknown>) =>
      dto((await post({ leadId: lead.id, ...body })).body);
    const p2 = await make({ kind: 'call', subject: 'p2', dueAt: DUE_2 });
    const p1 = await make({ kind: 'call', subject: 'p1', dueAt: DUE_1 });
    const cancelled = await make({ kind: 'call', subject: 'cancelled', dueAt: DUE_3 });
    const done = await make({ kind: 'meeting', subject: 'done', dueAt: DUE_3 });
    await make({ kind: 'note', subject: 'old', occurredAt: '2026-01-01T09:00:00.000Z' });
    await make({ kind: 'call', subject: 'new', occurredAt: '2026-02-01T09:00:00.000Z' });
    await setOnRow(cancelled.id, { cancelledAt: new Date() });
    await setOnRow(done.id, { completedAt: new Date() });

    const planned = await listed(`?leadId=${lead.id}&status=planned`);
    expect(planned.map((a) => a.subject)).toEqual(['p1', 'p2']);
    expect(planned.every((a) => a.planned)).toBe(true);

    // `done` was planned and completed, so it is History now; its occurred time is its creation (now).
    const logged = await listed(`?leadId=${lead.id}&status=logged`);
    expect(logged.map((a) => a.subject)).toEqual(['done', 'new', 'old']);
    expect(logged.some((a) => a.planned)).toBe(false);

    const all = (await listed(`?leadId=${lead.id}`)).map((a) => a.subject);
    expect(all.sort()).toEqual(['done', 'new', 'old', 'p1', 'p2']);
    expect(all).not.toContain(cancelled.subject);
    expect(p2.id).not.toBe(p1.id);

    expect((await list(`?leadId=${lead.id}&status=nonsense`)).status).toBe(400);
    h.as('salesB', 'sales');
    expect((await list(`?leadId=${lead.id}&status=planned`)).status).toBe(404);
  });

  it('filters by an inclusive due-day range in Asia/Kathmandu and drops rows without a due time', async () => {
    const lead = await seedLead();
    const make = (subject: string, dueAt?: string) =>
      post({
        leadId: lead.id,
        kind: dueAt ? 'call' : 'note',
        subject,
        ...(dueAt ? { dueAt } : {}),
      });
    // 18:15 UTC is midnight in Kathmandu (UTC+5:45).
    await make('before', '2029-12-31T18:14:00.000Z');
    await make('first', '2029-12-31T18:15:00.000Z');
    await make('middle', DUE_1);
    await make('last', '2030-01-02T18:14:00.000Z');
    await make('after', '2030-01-02T18:15:00.000Z');
    await make('no due time');

    const range = `?leadId=${lead.id}&dueFrom=2030-01-01&dueTo=2030-01-02`;
    const planned = await listed(`${range}&status=planned`);
    expect(planned.map((a) => a.subject)).toEqual(['first', 'middle', 'last']);
    expect((await listed(range)).map((a) => a.subject).sort()).toEqual(['first', 'last', 'middle']);
    const from = await listed(`?leadId=${lead.id}&dueFrom=2030-01-02&status=planned`);
    expect(from.map((a) => a.subject)).toEqual(['last', 'after']);
    const to = await listed(`?leadId=${lead.id}&dueTo=2029-12-31&status=planned`);
    expect(to.map((a) => a.subject)).toEqual(['before']);

    expect((await list(`?leadId=${lead.id}&dueFrom=2030-01-03&dueTo=2030-01-02`)).status).toBe(400);
    expect((await list(`?leadId=${lead.id}&dueFrom=tomorrow`)).status).toBe(400);
    h.as('salesB', 'sales');
    expect((await list(`${range}&status=planned`)).status).toBe(404);
  });

  it('records who changed a lead stage on its stage_change activity', async () => {
    const lead = await seedLead();
    // FR-6 (D48): a move to contacted logs a contact with it.
    await leadsService.changeStage(lead.id, {
      stage: 'contacted',
      expectedVersion: lead.version,
      contactActivity: { kind: 'call', body: 'Intro call' },
    });
    const [change] = await listed(`?leadId=${lead.id}&kind=stage_change`);
    expect(change).toMatchObject({ kind: 'stage_change', createdByUserId: h.users.salesA });
  });

  it('nextFollowUpSql gives each lead the earliest due time of its own planned activities', async () => {
    const a = await seedLead();
    const b = await seedLead();
    const none = await seedLead();
    await post({ kind: 'call', subject: 'a later', dueAt: DUE_3, leadId: a.id });
    await post({ kind: 'call', subject: 'a next', dueAt: DUE_2, leadId: a.id });
    const gone = dto((await post({ kind: 'call', subject: 'x', dueAt: DUE_1, leadId: a.id })).body);
    await setOnRow(gone.id, { cancelledAt: new Date() });
    await post({ kind: 'email', subject: 'b next', dueAt: DUE_1, leadId: b.id });
    await post({ kind: 'note', subject: 'logged only', leadId: none.id });

    const rows = await h.db
      .select({ id: leads.id, next: nextFollowUpSql() })
      .from(leads)
      .where(inArray(leads.id, [a.id, b.id, none.id]));
    const byId = new Map(rows.map((r) => [r.id, r.next]));
    expect(byId.get(a.id)).toBeInstanceOf(Date);
    expect(byId.get(a.id)?.toISOString()).toBe(DUE_2);
    expect(byId.get(b.id)?.toISOString()).toBe(DUE_1);
    expect(byId.get(none.id)).toBeNull();
  });

  it('never counts an old note, system or stage_change row with a due time as planned', async () => {
    const lead = await seedLead();
    // Old shapes the API no longer writes: a due time on a kind that is not a call, meeting or email.
    const old = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .insert(activities)
        .values(
          (['note', 'system', 'stage_change'] as const).map((kind) => ({
            ...h.scopeA,
            kind,
            subject: `old ${kind}`,
            leadId: lead.id,
            dueAt: new Date(DUE_1),
          })),
        )
        .returning(),
    );
    const oldIds = old.map((a) => a.id);

    expect(await listed(`?leadId=${lead.id}&status=planned`)).toEqual([]);
    const logged = await listed(`?leadId=${lead.id}&status=logged`);
    expect(logged.filter((a) => oldIds.includes(a.id)).map((a) => a.planned)).toEqual([
      false,
      false,
      false,
    ]);
    const [row] = await h.db
      .select({ next: nextFollowUpSql() })
      .from(leads)
      .where(eq(leads.id, lead.id));
    expect(row?.next).toBeNull();
    expect(LeadDtoSchema.parse(await leadsService.get(lead.id)).nextFollowUpAt).toBeNull();
  });
});

describe('PATCH /v1/activities/:id/complete|reschedule|cancel', () => {
  const patch = (id: string, action: 'complete' | 'reschedule' | 'cancel', body: unknown) =>
    request(baseUrl)
      .patch(`/v1/activities/${id}/${action}`)
      .send(body as object);
  const plan = async (leadId: string, subject: string, dueAt: string, body?: string) => {
    const res = await post({ kind: 'call', subject, dueAt, leadId, ...(body ? { body } : {}) });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return dto(res.body);
  };

  it('complete turns a planned activity into a logged one, appends the note, and refuses a second complete', async () => {
    const lead = await seedLead();
    const p = await plan(lead.id, 'Chase', DUE_1, 'Ask about budget');
    const before = Date.now();
    const res = await patch(p.id, 'complete', { expectedVersion: 1, note: 'Budget approved' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const done = dto(res.body);
    expect(done).toMatchObject({
      planned: false,
      dueAt: DUE_1,
      cancelledAt: null,
      body: 'Ask about budget\n\nBudget approved',
      version: 2,
    });
    expect(done.completedAt).not.toBeNull();
    expect(Date.parse(done.completedAt!)).toBeGreaterThanOrEqual(before - 1000);
    // Without an occurredAt it happened when it was completed.
    expect(done.occurredAt).toBe(done.completedAt);

    expect((await listed(`?leadId=${lead.id}&status=planned`)).map((a) => a.id)).not.toContain(
      p.id,
    );
    const logged = await listed(`?leadId=${lead.id}&status=logged`);
    expect(logged.find((a) => a.id === p.id)).toMatchObject({ occurredAt: done.completedAt });
    expect((await h.auditOf(p.id)).map((e) => e.action)).toContain('activity.completed');

    // Already done: not planned any more, even with the current version.
    const again = await patch(p.id, 'complete', { expectedVersion: 2 });
    expect(again.status, JSON.stringify(again.body)).toBe(409);
    expect(errorOf(again.body).code).toBe('conflict');
    expect((await patch(p.id, 'cancel', { expectedVersion: 2 })).status).toBe(409);
  });

  it('complete takes the time it actually happened, and keeps a note as the only details', async () => {
    const lead = await seedLead();
    const p = await plan(lead.id, 'Chase', DUE_1);
    const at = '2026-03-04T05:06:07.000Z';
    const res = await patch(p.id, 'complete', { expectedVersion: 1, occurredAt: at, note: 'Done' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({ occurredAt: at, body: 'Done', planned: false });
  });

  it('answers 409 for a stale expectedVersion on a row that is still planned', async () => {
    const lead = await seedLead();
    const p = await plan(lead.id, 'Chase', DUE_1);
    expect((await patch(p.id, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 })).status).toBe(
      200,
    );
    for (const [action, body] of [
      ['complete', { expectedVersion: 1 }],
      ['reschedule', { expectedVersion: 1, dueAt: DUE_3 }],
      ['cancel', { expectedVersion: 1 }],
    ] as const) {
      const res = await patch(p.id, action, body);
      expect(res.status, action).toBe(409);
      expect(errorOf(res.body).code).toBe('conflict');
    }
    const [still] = await listed(`?leadId=${lead.id}&status=planned`);
    expect(still).toMatchObject({ id: p.id, planned: true, dueAt: DUE_2, version: 2 });
  });

  it('reschedule moves the due time (and the planned order) and can hand it to another user', async () => {
    const lead = await seedLead();
    const first = await plan(lead.id, 'first', DUE_1);
    await plan(lead.id, 'second', DUE_2);
    expect((await listed(`?leadId=${lead.id}&status=planned`)).map((a) => a.subject)).toEqual([
      'first',
      'second',
    ]);

    // The rule refuses a hand-over between two salespeople with no department; the Founder may hand it to anyone.
    const handed = await patch(first.id, 'reschedule', {
      expectedVersion: 1,
      dueAt: DUE_3,
      assigneeUserId: h.users.salesB,
    });
    expect(handed.status, JSON.stringify(handed.body)).toBe(400);
    expect(errorOf(handed.body).code).toBe('bad_request');
    const { inactive, portal } = await outsiders();
    h.as('boss', 'founder');
    for (const assigneeUserId of [inactive, portal]) {
      const res = await patch(first.id, 'reschedule', {
        expectedVersion: 1,
        dueAt: DUE_3,
        assigneeUserId,
      });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(errorOf(res.body).message).toBe(
        'assigneeUserId is not an active staff member of this entity',
      );
    }
    const res = await patch(first.id, 'reschedule', {
      expectedVersion: 1,
      dueAt: DUE_3,
      assigneeUserId: h.users.salesB,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({
      dueAt: DUE_3,
      assigneeUserId: h.users.salesB,
      planned: true,
      version: 2,
    });
    expect((await listed(`?leadId=${lead.id}&status=planned`)).map((a) => a.subject)).toEqual([
      'second',
      'first',
    ]);
    expect((await h.auditOf(first.id)).map((e) => e.action)).toContain('activity.rescheduled');

    const stranger = await patch(first.id, 'reschedule', {
      expectedVersion: 2,
      dueAt: DUE_1,
      assigneeUserId: crypto.randomUUID(),
    });
    expect(stranger.status, JSON.stringify(stranger.body)).toBe(400);
  });

  it('cancel hides the activity from both lists and is audited', async () => {
    const lead = await seedLead();
    const p = await plan(lead.id, 'Never mind', DUE_1);
    const res = await patch(p.id, 'cancel', { expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const cancelled = dto(res.body);
    expect(cancelled).toMatchObject({ planned: false, completedAt: null, version: 2 });
    expect(cancelled.cancelledAt).not.toBeNull();
    for (const query of [`?leadId=${lead.id}&status=planned`, `?leadId=${lead.id}&status=logged`]) {
      expect(
        (await listed(query)).map((a) => a.id),
        query,
      ).not.toContain(p.id);
    }
    expect((await h.auditOf(p.id)).map((e) => e.action)).toContain('activity.cancelled');
    expect((await patch(p.id, 'cancel', { expectedVersion: 2 })).status).toBe(409);
  });

  it('refuses a logged activity and a system-written kind with 409', async () => {
    const lead = await seedLead();
    const logged = dto((await post({ kind: 'note', subject: 'Called', leadId: lead.id })).body);
    expect((await patch(logged.id, 'complete', { expectedVersion: 1 })).status).toBe(409);
    // A system row with a due time would look planned by the column rule; its kind still refuses it.
    const [system] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .insert(activities)
        .values({
          ...h.scopeA,
          kind: 'system',
          subject: 'x',
          leadId: lead.id,
          dueAt: new Date(DUE_1),
        })
        .returning(),
    );
    for (const action of ['complete', 'cancel'] as const) {
      const res = await patch(system!.id, action, { expectedVersion: 1 });
      expect(res.status, action).toBe(409);
    }
    const res = await patch(system!.id, 'reschedule', { expectedVersion: 1, dueAt: DUE_2 });
    expect(res.status).toBe(409);
  });

  it('answers 404 outside the caller scope, 403 for a read-only role, 400 for a bad id or body', async () => {
    const lead = await seedLead(); // salesA's
    const p = await plan(lead.id, 'Mine', DUE_1);

    // An unknown id and a colleague's activity answer the same 404, so a guessed id learns nothing.
    const unknown = await patch(crypto.randomUUID(), 'complete', { expectedVersion: 1 });
    expect(unknown.status).toBe(404);
    const unknownError = errorOf(unknown.body);
    expect(unknownError).toMatchObject({ code: 'not_found', message: 'Activity not found' });
    h.as('salesB', 'sales'); // own scope: a colleague's lead is out of reach
    for (const [action, body] of [
      ['complete', { expectedVersion: 1 }],
      ['reschedule', { expectedVersion: 1, dueAt: DUE_2 }],
      ['cancel', { expectedVersion: 1 }],
    ] as const) {
      const res = await patch(p.id, action, body);
      expect(res.status, action).toBe(404);
      const error = errorOf(res.body);
      expect({ code: error.code, message: error.message }, action).toEqual({
        code: unknownError.code,
        message: unknownError.message,
      });
    }
    h.as('salesB', 'sales', 'B'); // another entity: the row itself is not found
    expect((await patch(p.id, 'complete', { expectedVersion: 1 })).status).toBe(404);
    h.as('viewer', 'management');
    expect((await patch(p.id, 'complete', { expectedVersion: 1 })).status).toBe(403);

    h.as('salesA', 'sales');
    expect((await patch(crypto.randomUUID(), 'cancel', { expectedVersion: 1 })).status).toBe(404);
    expect((await patch('not-a-guid', 'cancel', { expectedVersion: 1 })).status).toBe(400);
    expect((await patch(p.id, 'complete', { expectedVersion: 1, extra: true })).status).toBe(400);
    const [untouched] = await listed(`?leadId=${lead.id}&status=planned`);
    expect(untouched).toMatchObject({ id: p.id, version: 1 });
  });
});

describe("D46: an activity carries its assignee's and author's display names and no address", () => {
  it('shows Sales the names of a follow-up assigned to the Founder, on list, create and complete, with no address', async () => {
    for (const [key, name, email] of [
      ['salesA', 'Sita Sales', 'sita.private@crestia.example'],
      ['boss', 'Fiona Founder', 'fiona.private@crestia.example'],
    ] as const) {
      await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        tx.update(users).set({ displayName: name, email }).where(eq(users.id, h.users[key])),
      );
    }
    const lead = await seedLead();
    // A Sales (own scope) caller cannot assign to the Founder over HTTP, so the Founder's follow-up is written
    // directly: what matters is what Sales then reads back.
    const [row] = await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .insert(activities)
        .values({
          ...h.scopeA,
          kind: 'call',
          subject: 'Check the brief',
          leadId: lead.id,
          dueAt: new Date(Date.now() + 86_400_000),
          assigneeUserId: h.users.boss,
          createdByUserId: h.users.boss,
        })
        .returning(),
    );
    const seen = (await listed(`?leadId=${lead.id}&status=planned`)).find((a) => a.id === row!.id);
    expect(seen).toMatchObject({
      assigneeName: 'Fiona Founder',
      createdByName: 'Fiona Founder',
    });

    const created = await post({
      kind: 'call',
      subject: 'My own follow-up',
      leadId: lead.id,
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(dto(created.body)).toMatchObject({
      assigneeName: 'Sita Sales',
      createdByName: 'Sita Sales',
    });

    const text = JSON.stringify([seen, created.body, await listed(`?leadId=${lead.id}`)]);
    expect(text).not.toMatch(/@crestia\.example/);
  });

  it('has null names on an activity that names no one', async () => {
    const lead = await seedLead();
    const logged = await post({ kind: 'note', subject: 'Met at the fair', leadId: lead.id });
    expect(logged.status, JSON.stringify(logged.body)).toBe(201);
    expect(dto(logged.body)).toMatchObject({ assigneeUserId: null, assigneeName: null });
  });
});

describe('D45: a follow-up planned while its lead changes owner', () => {
  it('waits for the owner change in flight and goes to the new owner, never to the old one unmoved', async () => {
    h.as('boss', 'founder');
    const lead = await seedLead();
    expect(lead.ownerUserId).toBe(h.users.boss);

    // The owner change stops inside its transaction, after it locked the lead, changed the owner and moved the old
    // owner's follow-ups: its notice to the new owner is the last thing before the commit.
    let markHeld!: () => void;
    const held = new Promise<void>((resolve) => {
      markHeld = resolve;
    });
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const notifyUser = h.notify.notifyUser.bind(h.notify);
    const spy = vi.spyOn(h.notify, 'notifyUser').mockImplementationOnce(async (...args) => {
      markHeld();
      await released;
      return notifyUser(...args);
    });
    try {
      const transfer = leadsService.update(lead.id, {
        ownerUserId: h.users.salesA,
        expectedVersion: 1,
      });
      await Promise.race([
        held,
        transfer.then(() => {
          throw new Error('the owner change committed without telling the new owner');
        }),
      ]);
      let settled = false;
      const creating = post({
        kind: 'call',
        subject: 'Call back',
        leadId: lead.id,
        dueAt: DUE_1,
      }).then((res) => {
        settled = true;
        return res;
      });
      try {
        // Wait for a signal, not a clock: either the follow-up's statement is blocked on a lock, or it finished.
        let blocked: string | undefined;
        while (blocked === undefined && !settled) {
          const { rows } = await h.appPool.query(
            `SELECT query FROM pg_stat_activity
              WHERE datname = current_database() AND wait_event_type = 'Lock'`,
          );
          blocked = (rows as { query: string }[])[0]?.query;
          if (blocked === undefined) await new Promise((resolve) => setImmediate(resolve));
        }
        expect(settled, 'the follow-up did not wait for the owner change').toBe(false);
        // It waits for the tenant audit lock withTx takes first (the owner change holds it), before it reads the lead.
        expect(blocked).toMatch(/pg_advisory_xact_lock\(hashtextextended\('audit\.chain:'/);
      } finally {
        release();
      }
      expect((await transfer).ownerUserId).toBe(h.users.salesA);
      const res = await creating;
      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(dto(res.body).assigneeUserId).toBe(h.users.salesA);
    } finally {
      spy.mockRestore();
    }
  });
});
