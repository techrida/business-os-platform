// Integration tests of the leads API on a real Postgres (Testcontainers, needs Docker in WSL). Real: migrations,
// LeadsService, NumberingService, AuditService, and the controller behind the production body parser and error
// filter. Faked: the request context and authz.assert (see test/harness.ts). Every response is parsed with the
// contract schema the workspace uses.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { activities, leads } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq } from 'drizzle-orm';
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
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness } from './test/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let service: LeadsService;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  service = new LeadsService(
    h.db,
    h.authz as unknown as AuthzService,
    new AuditService(h.db),
    new NumberingService(),
    h.caller,
    new LeadLostReasonsService(h.db, new AuditService(h.db), h.caller),
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [LeadsController],
    providers: [{ provide: LeadsService, useValue: service }],
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

const BODY = {
  title: 'Website for Acme',
  source: 'referral',
  companyName: 'Acme Pvt. Ltd.',
  contactName: 'Sita Rai',
  email: 'Sita@Acme.example',
};

const post = (body: Record<string, unknown> = BODY, key?: string) => {
  const req = request(baseUrl).post('/v1/leads');
  if (key !== undefined) req.set('Idempotency-Key', key);
  return req.send(body);
};
const patchStage = (id: string, body: Record<string, unknown>) =>
  request(baseUrl).patch(`/v1/leads/${id}/stage`).send(body);
const dto = (body: unknown) => LeadDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;

async function seed(extra: Record<string, unknown> = {}) {
  const res = await post({ ...BODY, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dto(res.body);
}

describe('POST /v1/leads', () => {
  it('creates a lead numbered from the LD series, owned by the caller, and audits it', async () => {
    const first = await seed();
    const second = await seed();
    expect(first.number).toMatch(/^LD-/);
    expect(second.number).toMatch(/^LD-/);
    expect(second.number).not.toBe(first.number);
    expect(first).toMatchObject({
      stage: 'new',
      version: 1,
      ownerUserId: h.users.salesA,
      email: 'sita@acme.example',
      currency: 'NPR',
    });
    expect((await h.auditOf(first.id)).map((e) => e.action)).toContain('lead.created');
  });

  it('runs once per Idempotency-Key, and refuses the key for a different body', async () => {
    const key = `key-${Date.now()}`;
    const a = await post({ ...BODY, title: 'Once' }, key);
    const b = await post({ ...BODY, title: 'Once' }, key);
    expect(a.status).toBe(201);
    expect(b.body).toEqual(a.body);
    const rows = await h.db
      .select()
      .from(leads)
      .where(eq(leads.id, dto(a.body).id));
    expect(rows).toHaveLength(1);
    expect((await post({ ...BODY, title: 'Different' }, key)).status).toBe(422);
  });

  it('refuses a body the contract rejects with 400, and an owner the caller cannot reach with 403', async () => {
    expect((await post({ ...BODY, source: 'telepathy' })).status).toBe(400);
    const other = await post({ ...BODY, ownerUserId: h.users.salesB });
    expect(other.status).toBe(403);
    // A role with a wider grant may name another owner.
    h.as('boss', 'founder');
    const ok = await post({ ...BODY, ownerUserId: h.users.salesB });
    expect(ok.status, JSON.stringify(ok.body)).toBe(201);
    expect(dto(ok.body).ownerUserId).toBe(h.users.salesB);
  });

  it('refuses a caller without crm.lead.write on the record at all', async () => {
    h.as('viewer', 'management');
    expect((await post()).status).toBe(403);
  });
});

describe('POST /v1/leads with a follow-up (D39)', () => {
  const plannedOf = (leadId: string) =>
    h.db.select().from(activities).where(eq(activities.leadId, leadId));
  const iso = (s: string) => new Date(s).toISOString();

  it('plans the followUp as an activity assigned to the owner, named after its kind, and derives nextFollowUpAt', async () => {
    h.as('boss', 'founder');
    const dueAt = '2030-01-02T03:04:05Z';
    const lead = await seed({
      ownerUserId: h.users.salesB,
      followUp: { kind: 'meeting', dueAt, body: 'Bring the brochure' },
    });
    expect(lead.nextFollowUpAt).toBe(iso(dueAt));
    const rows = await plannedOf(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'meeting',
      subject: 'Meeting',
      body: 'Bring the brochure',
      assigneeUserId: h.users.salesB,
      createdByUserId: h.users.boss,
      completedAt: null,
      cancelledAt: null,
    });
    expect(rows[0]!.dueAt!.toISOString()).toBe(iso(dueAt));
    expect((await h.auditOf(rows[0]!.id)).map((e) => e.action)).toContain('activity.scheduled');
    // The rollback-only column is no longer written.
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.nextFollowUpAt).toBeNull();
  });

  it('keeps a named assignee and subject', async () => {
    h.as('boss', 'founder');
    const lead = await seed({
      followUp: {
        kind: 'email',
        dueAt: '2030-02-01T09:00:00Z',
        assigneeUserId: h.users.salesB,
        subject: 'Send the quote',
      },
    });
    const [row] = await plannedOf(lead.id);
    expect(row).toMatchObject({
      kind: 'email',
      subject: 'Send the quote',
      assigneeUserId: h.users.salesB,
      createdByUserId: h.users.boss,
    });
  });

  it('refuses a follow-up an own-scope caller hands to a colleague with 400, and creates nothing', async () => {
    const title = `Handed ${randomUUID()}`;
    const res = await post({
      ...BODY,
      title,
      followUp: { kind: 'call', dueAt: '2030-01-01T00:00:00Z', assigneeUserId: h.users.salesB },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'bad_request',
      message:
        'followUp.assigneeUserId cannot be someone else: your access covers only your own leads',
    });
    expect(await h.db.select().from(leads).where(eq(leads.title, title))).toHaveLength(0);
  });

  it('maps the old nextFollowUpAt to a planned call named "Follow up" for the owner', async () => {
    const dueAt = '2030-03-04T05:06:07.000Z';
    const lead = await seed({ nextFollowUpAt: dueAt });
    expect(lead.nextFollowUpAt).toBe(iso(dueAt));
    const rows = await plannedOf(lead.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: 'call',
      subject: 'Follow up',
      assigneeUserId: h.users.salesA,
      createdByUserId: h.users.salesA,
    });
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row!.nextFollowUpAt).toBeNull();
  });

  it('refuses followUp and nextFollowUpAt together with 400', async () => {
    const dueAt = '2030-01-01T00:00:00Z';
    const res = await post({ ...BODY, nextFollowUpAt: dueAt, followUp: { kind: 'call', dueAt } });
    expect(res.status).toBe(400);
  });

  it('refuses an assignee who is not a user of the tenant with 400, and creates nothing', async () => {
    const title = `Atomic ${randomUUID()}`;
    const subject = `Ghost ${randomUUID()}`;
    const res = await post({
      ...BODY,
      title,
      followUp: {
        kind: 'call',
        dueAt: '2030-01-01T00:00:00Z',
        assigneeUserId: randomUUID(),
        subject,
      },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body).message).toContain('assigneeUserId');
    expect(await h.db.select().from(leads).where(eq(leads.title, title))).toHaveLength(0);
    expect(
      await h.db.select().from(activities).where(eq(activities.subject, subject)),
    ).toHaveLength(0);
  });

  it('derives nextFollowUpAt as the earliest planned due time, ignoring completed, cancelled and logged rows, the same in list, get and a stage change', async () => {
    const title = `Derived ${randomUUID()}`;
    const lead = await seed({ title, followUp: { kind: 'call', dueAt: '2031-01-01T00:00:00Z' } });
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx.insert(activities).values([
        {
          ...h.scopeA,
          kind: 'call',
          subject: 'Done early',
          leadId: lead.id,
          dueAt: new Date('2028-01-01T00:00:00Z'),
          completedAt: new Date('2028-01-01T00:00:00Z'),
        },
        {
          ...h.scopeA,
          kind: 'meeting',
          subject: 'Cancelled earlier',
          leadId: lead.id,
          dueAt: new Date('2027-01-01T00:00:00Z'),
          cancelledAt: new Date('2027-01-01T00:00:00Z'),
        },
        { ...h.scopeA, kind: 'note', subject: 'Logged', leadId: lead.id },
        {
          ...h.scopeA,
          kind: 'email',
          subject: 'Next',
          leadId: lead.id,
          dueAt: new Date('2030-06-01T00:00:00Z'),
        },
      ]),
    );
    const expected = '2030-06-01T00:00:00.000Z';
    const got = dto((await request(baseUrl).get(`/v1/leads/${lead.id}`)).body);
    expect(got.nextFollowUpAt).toBe(expected);
    const listed = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get(`/v1/leads?q=${encodeURIComponent(title)}`)).body);
    expect(listed.map((l) => [l.id, l.nextFollowUpAt])).toEqual([[lead.id, expected]]);
    const moved = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 });
    expect(dto(moved.body).nextFollowUpAt).toBe(expected);

    const bareTitle = `Bare ${randomUUID()}`;
    const bare = await seed({ title: bareTitle });
    expect(bare.nextFollowUpAt).toBeNull();
    expect(dto((await request(baseUrl).get(`/v1/leads/${bare.id}`)).body).nextFollowUpAt).toBe(
      null,
    );
    const bareListed = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get(`/v1/leads?q=${encodeURIComponent(bareTitle)}`)).body);
    expect(bareListed.map((l) => l.nextFollowUpAt)).toEqual([null]);
  });
});

describe('GET /v1/leads', () => {
  it('returns a bare array limited to the caller scope and entity, and filters by stage and text', async () => {
    const mine = await seed({ title: 'Zeta mine 50%' });
    h.as('salesB', 'sales');
    const theirs = await seed({ title: 'Zeta theirs' });
    h.as('salesB', 'sales', 'B');
    const otherEntity = await seed({ title: 'Zeta other entity' });

    h.as('salesA', 'sales');
    const res = await request(baseUrl).get('/v1/leads?limit=200');
    expect(res.status).toBe(200);
    const ids = z
      .array(LeadDtoSchema)
      .parse(res.body)
      .map((l) => l.id);
    expect(ids).toContain(mine.id);
    // `own` scope: a colleague's lead is not in the list, and neither is a lead of another entity.
    expect(ids).not.toContain(theirs.id);
    expect(ids).not.toContain(otherEntity.id);

    h.as('boss', 'founder');
    const all = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get('/v1/leads?q=zeta&limit=200')).body)
      .map((l) => l.id);
    expect(all).toEqual(expect.arrayContaining([mine.id, theirs.id]));
    expect(all).not.toContain(otherEntity.id);

    const percent = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get('/v1/leads?q=50%25')).body);
    expect(percent.map((l) => l.id)).toEqual([mine.id]);
    const news = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get('/v1/leads?stage=new&limit=200')).body);
    expect(news.every((l) => l.stage === 'new')).toBe(true);
    expect((await request(baseUrl).get('/v1/leads?stage=nonsense')).status).toBe(400);
  });
});

describe('GET /v1/leads/:id', () => {
  it('answers 404, not 403, for a colleague lead, another entity lead and an unknown id', async () => {
    h.as('salesB', 'sales');
    const colleague = await seed();
    h.as('salesB', 'sales', 'B');
    const otherEntity = await seed();

    h.as('salesA', 'sales');
    for (const id of [colleague.id, otherEntity.id, '00000000-0000-4000-8000-000000000000']) {
      const res = await request(baseUrl).get(`/v1/leads/${id}`);
      expect(res.status, id).toBe(404);
      expect(errorOf(res.body).code).toBe('not_found');
    }
    const mine = await seed();
    expect((await request(baseUrl).get(`/v1/leads/${mine.id}`)).status).toBe(200);
  });
});

describe('PATCH /v1/leads/:id/stage', () => {
  it('follows the table: a valid move bumps the version, writes an audit event and a stage_change activity', async () => {
    const lead = await seed();
    const res = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({ stage: 'contacted', version: 2 });
    expect((await h.auditOf(lead.id)).map((e) => e.action)).toContain('lead.stage_changed');
    const rows = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'stage_change' });
  });

  it('refuses a move the table has no edge for with 409, and a stale version with 409', async () => {
    const lead = await seed();
    const skip = await patchStage(lead.id, { stage: 'qualified', expectedVersion: 1 });
    expect(skip.status).toBe(409);
    expect(errorOf(skip.body).code).toBe('conflict');
    expect((await patchStage(lead.id, { stage: 'contacted', expectedVersion: 7 })).status).toBe(
      409,
    );
  });

  it('never sets converted: 400 at the edge, and nothing changes', async () => {
    const lead = await seed();
    await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 });
    await patchStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
    const res = await patchStage(lead.id, { stage: 'converted', expectedVersion: 3 });
    expect(res.status).toBe(400);
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row).toMatchObject({ stage: 'qualified', convertedOpportunityId: null });
  });

  it('needs a reason and a note for lost and on_hold, and a user cannot reopen a lost lead', async () => {
    const lead = await seed();
    expect((await patchStage(lead.id, { stage: 'lost', expectedVersion: 1 })).status).toBe(400);
    expect(
      (await patchStage(lead.id, { stage: 'lost', newLostReason: 'Price', expectedVersion: 1 }))
        .status,
    ).toBe(400);
    const lost = await patchStage(lead.id, {
      stage: 'lost',
      newLostReason: 'Too dear for them',
      note: 'too dear',
      expectedVersion: 1,
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(dto(lost.body)).toMatchObject({
      stageReason: 'Too dear for them',
      stageNote: 'too dear',
      lostReason: { label: 'Too dear for them', retired: false },
    });
    const reopen = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 2 });
    expect(reopen.status).toBe(403);
  });

  it('clears the reason and note when a lead leaves on_hold', async () => {
    const lead = await seed();
    await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'next year',
      expectedVersion: 1,
    });
    const back = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 2 });
    expect(dto(back.body)).toMatchObject({
      stage: 'contacted',
      stageReason: null,
      stageNote: null,
    });
  });

  it('answers 404 for another entity lead and a colleague lead, and 403 for a read-only role', async () => {
    h.as('salesB', 'sales');
    const colleague = await seed();
    h.as('salesB', 'sales', 'B');
    const otherEntity = await seed();

    h.as('salesA', 'sales');
    for (const id of [colleague.id, otherEntity.id]) {
      expect((await patchStage(id, { stage: 'contacted', expectedVersion: 1 })).status, id).toBe(
        404,
      );
    }
    h.as('viewer', 'management');
    const mine = await (async () => {
      h.as('salesA', 'sales');
      const l = await seed();
      h.as('viewer', 'management');
      return l;
    })();
    expect((await patchStage(mine.id, { stage: 'contacted', expectedVersion: 1 })).status).toBe(
      403,
    );
  });
});
