// Integration tests of the leads API on a real Postgres (Testcontainers, needs Docker in WSL). Real: migrations,
// LeadsService, NumberingService, AuditService, and the controller behind the production body parser and error
// filter. Faked: the request context and authz.assert (see test/harness.ts). Every response is parsed with the
// contract schema the workspace uses.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LEAD_STAGES, LeadDtoSchema } from '@bos/contracts';
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
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';

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
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, new AuditService(h.db), h.caller),
    h.roleCache,
    h.notify,
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
/** FR-6 (D48): every move to contacted needs a contact, so a test move logs a call in the same request. */
const CONTACT = { kind: 'call', body: 'Intro call' } as const;
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

  it('refuses a body the contract rejects with 400, and an owner the assignment rule refuses with 400', async () => {
    expect((await post({ ...BODY, source: 'telepathy' })).status).toBe(400);
    // Neither salesperson belongs to a department, so the rule has no department to hand within (D50).
    const other = await post({ ...BODY, ownerUserId: h.users.salesB });
    expect(other.status, JSON.stringify(other.body)).toBe(400);
    expect(errorOf(other.body).message).toBe(
      'ownerUserId needs you and them to belong to a department',
    );
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

  it('refuses a follow-up the assignment rule does not let the caller hand to a colleague with 400, and creates nothing', async () => {
    const title = `Handed ${randomUUID()}`;
    const res = await post({
      ...BODY,
      title,
      followUp: { kind: 'call', dueAt: '2030-01-01T00:00:00Z', assigneeUserId: h.users.salesB },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body)).toMatchObject({
      code: 'bad_request',
      message: 'followUp.assigneeUserId needs you and them to belong to a department',
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
    const moved = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 1,
      contactActivity: CONTACT,
    });
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

    // "50%" is text, not a wildcard. One exact hit means fuzzy mode is on, so close matches may follow the
    // exact one; what must hold is that the wildcard did not match everything.
    const percent = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get('/v1/leads?q=50%25')).body);
    expect(percent[0]?.id).toBe(mine.id);
    expect(percent.map((l) => l.id)).not.toContain(theirs.id);
    const news = z
      .array(LeadDtoSchema)
      .parse((await request(baseUrl).get('/v1/leads?stage=new&limit=200')).body);
    expect(news.every((l) => l.stage === 'new')).toBe(true);
    expect((await request(baseUrl).get('/v1/leads?stage=nonsense')).status).toBe(400);
  });

  it('refuses unknown params, a bad enum, a bad uuid and a repeated q with 400', async () => {
    for (const qs of [
      'status=new',
      'stage=nonsense',
      'stage=new&stage=nonsense',
      'source=telepathy',
      'ownerUserId=not-a-uuid',
      'limit=201',
      'offset=-1',
      'q=ab&q=cd',
    ]) {
      const res = await request(baseUrl).get(`/v1/leads?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(errorOf(res.body).code, qs).toBe('bad_request');
    }
  });

  it('puts the total of all matches in X-Total-Count, and offset pages do not overlap', async () => {
    h.as('boss', 'founder');
    const made = [];
    for (let i = 0; i < 6; i += 1) made.push(await seed({ title: `Pagerzed lead ${i}` }));
    const page = async (offset: number) => {
      const res = await request(baseUrl).get(`/v1/leads?q=Pagerzed&limit=2&offset=${offset}`);
      expect(res.status).toBe(200);
      return { total: res.headers['x-total-count'], ids: z.array(LeadDtoSchema).parse(res.body) };
    };
    const [p1, p2, p3, p4] = [await page(0), await page(2), await page(4), await page(6)];
    // Six exact hits: exact mode, so the total is exactly the six, larger than any page.
    for (const p of [p1, p2, p3, p4]) expect(p.total).toBe('6');
    expect([p1.ids.length, p2.ids.length, p3.ids.length, p4.ids.length]).toEqual([2, 2, 2, 0]);
    const seen = [...p1.ids, ...p2.ids, ...p3.ids].map((l) => l.id);
    expect(new Set(seen).size).toBe(6);
    expect([...seen].sort()).toEqual(made.map((l) => l.id).sort());
    const none = await request(baseUrl).get('/v1/leads?q=Pagerzed&stage=lost');
    expect([none.headers['x-total-count'], none.body]).toEqual(['0', []]);
  });

  it("finds 'Himalyan Traders' for 'Himalayan' in the company name, never from another entity", async () => {
    const typo = await seed({ title: 'Bulk order', companyName: 'Himalyan Traders Pvt Ltd' });
    h.as('salesB', 'sales', 'B');
    const otherEntity = await seed({ companyName: 'Himalyan Exports' });
    h.as('salesA', 'sales');
    const res = await request(baseUrl).get('/v1/leads?q=Himalayan');
    expect(res.status).toBe(200);
    const ids = z
      .array(LeadDtoSchema)
      .parse(res.body)
      .map((l) => l.id);
    expect(ids).toContain(typo.id);
    expect(ids).not.toContain(otherEntity.id);
    expect(Number(res.headers['x-total-count'])).toBe(ids.length);
  });

  it('searches the email, phone and campaign columns', async () => {
    const lead = await seed({
      title: 'Columns',
      email: 'unique.buyer@searchcols.example',
      phone: '+9779801234567',
      campaign: 'Dashain Flyer 2082',
    });
    for (const q of ['searchcols', '9801234567', 'Dashain Flyer']) {
      const res = await request(baseUrl).get(`/v1/leads?q=${encodeURIComponent(q)}`);
      const ids = z
        .array(LeadDtoSchema)
        .parse(res.body)
        .map((l) => l.id);
      expect(ids, q).toContain(lead.id);
    }
  });

  it('filters by repeated stage, source and owner, and never widens the caller scope', async () => {
    const own = await seed({ title: 'Filter own', source: 'event' });
    const moved = await seed({ title: 'Filter moved', source: 'partner' });
    expect(
      (
        await patchStage(moved.id, {
          stage: 'contacted',
          expectedVersion: 1,
          contactActivity: CONTACT,
        })
      ).status,
    ).toBe(200);
    h.as('salesB', 'sales');
    const colleague = await seed({ title: 'Filter colleague', source: 'event' });

    h.as('salesA', 'sales');
    const ids = async (qs: string) =>
      z
        .array(LeadDtoSchema)
        .parse((await request(baseUrl).get(`/v1/leads?${qs}`)).body)
        .map((l) => l.id);
    expect(await ids('q=Filter&stage=new&stage=contacted&limit=200')).toEqual(
      expect.arrayContaining([own.id, moved.id]),
    );
    expect(await ids('q=Filter&stage=contacted&limit=200')).toEqual([moved.id]);
    expect(await ids('q=Filter&source=event&source=partner&limit=200')).toEqual(
      expect.arrayContaining([own.id, moved.id]),
    );
    expect(await ids('q=Filter&source=partner&limit=200')).toEqual([moved.id]);
    // A colleague as the owner filter: the own scope still applies, so the answer is empty, not the colleague's.
    const other = await request(baseUrl).get(
      `/v1/leads?q=Filter&ownerUserId=${h.users.salesB}&limit=200`,
    );
    expect(other.body).toEqual([]);
    expect(other.headers['x-total-count']).toBe('0');
    expect(
      await ids(`ownerUserId=${h.users.salesB}&ownerUserId=${h.users.salesA}&q=Filter`),
    ).toEqual(expect.not.arrayContaining([colleague.id]));

    h.as('boss', 'founder');
    expect(await ids(`q=Filter&ownerUserId=${h.users.salesB}&limit=200`)).toEqual([colleague.id]);
  });
});

describe('GET /v1/leads/summary', () => {
  const summaryOf = async (qs = '') => {
    const res = await request(baseUrl).get(`/v1/leads/summary${qs}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return SummarySchema.parse(res.body);
  };
  const SummarySchema = z.object({
    total: z.number(),
    byStage: z.record(z.string(), z.number()),
  });

  it('counts per stage with every stage present, and agrees with the list for each stage filter', async () => {
    await seed({ title: 'Cards one' });
    const two = await seed({ title: 'Cards two' });
    await patchStage(two.id, { stage: 'contacted', expectedVersion: 1, contactActivity: CONTACT });

    const summary = await summaryOf();
    expect(Object.keys(summary.byStage).sort()).toEqual([...LEAD_STAGES].sort());
    expect(Object.values(summary.byStage).reduce((a, b) => a + b, 0)).toBe(summary.total);
    for (const stage of LEAD_STAGES) {
      const res = await request(baseUrl).get(`/v1/leads?stage=${stage}&limit=1`);
      expect(Number(res.headers['x-total-count']), stage).toBe(summary.byStage[stage]);
    }
    expect(Number((await request(baseUrl).get('/v1/leads?limit=1')).headers['x-total-count'])).toBe(
      summary.total,
    );
    expect(summary.byStage.new).toBeGreaterThanOrEqual(1);
    expect(summary.byStage.contacted).toBeGreaterThanOrEqual(1);
  });

  it('follows the list search and filters, but not a stage', async () => {
    await seed({ title: 'Summed alpha', source: 'event' });
    await seed({ title: 'Summed beta', source: 'partner' });
    expect((await summaryOf('?q=Summed')).total).toBe(2);
    expect((await summaryOf('?q=Summed&source=event')).total).toBe(1);
    expect((await summaryOf('?q=Summed&source=event&source=partner')).total).toBe(2);
    expect((await summaryOf(`?q=Summed&ownerUserId=${h.users.salesA}`)).total).toBe(2);
  });

  it('keeps the caller scope: a colleague owner filter gives zero, and an unreadable role sees none', async () => {
    h.as('salesB', 'sales');
    await seed({ title: 'Scoped colleague' });
    h.as('salesB', 'sales', 'B');
    await seed({ title: 'Scoped colleague other entity' });

    h.as('salesA', 'sales');
    const mine = await summaryOf(`?q=Scoped&ownerUserId=${h.users.salesB}`);
    expect(mine.total).toBe(0);
    expect(Object.values(mine.byStage).every((n) => n === 0)).toBe(true);
    const list = await request(baseUrl).get(`/v1/leads?q=Scoped&ownerUserId=${h.users.salesB}`);
    expect(list.headers['x-total-count']).toBe('0');

    h.as('boss', 'founder');
    expect((await summaryOf('?q=Scoped')).total).toBe(1);
    h.as('viewer', 'customer_user');
    expect((await summaryOf()).total).toBe(0);
    expect((await request(baseUrl).get('/v1/leads')).headers['x-total-count']).toBe('0');
  });

  it('refuses a stage, paging, unknown params and bad values with 400, and is not read as an id', async () => {
    for (const qs of [
      'stage=new',
      'limit=5',
      'offset=0',
      'status=new',
      'source=x',
      'ownerUserId=x',
    ]) {
      const res = await request(baseUrl).get(`/v1/leads/summary?${qs}`);
      expect(res.status, qs).toBe(400);
      expect(errorOf(res.body).code, qs).toBe('bad_request');
    }
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
    const res = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 1,
      contactActivity: CONTACT,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({ stage: 'contacted', version: 2 });
    expect((await h.auditOf(lead.id)).map((e) => e.action)).toContain('lead.stage_changed');
    // The logged contact plus the stage_change row.
    const rows = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(rows.map((r) => r.kind).sort()).toEqual(['call', 'stage_change']);
  });

  it('refuses a move the table has no edge for with 409, and a stale version with 409', async () => {
    const lead = await seed();
    const skip = await patchStage(lead.id, { stage: 'qualified', expectedVersion: 1 });
    expect(skip.status).toBe(409);
    expect(errorOf(skip.body).code).toBe('conflict');
    expect(
      (
        await patchStage(lead.id, {
          stage: 'contacted',
          expectedVersion: 7,
          contactActivity: CONTACT,
        })
      ).status,
    ).toBe(409);
  });

  it('never sets converted: 400 at the edge, and nothing changes', async () => {
    const lead = await seed();
    await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1, contactActivity: CONTACT });
    await patchStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
    const res = await patchStage(lead.id, { stage: 'converted', expectedVersion: 3 });
    expect(res.status).toBe(400);
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row).toMatchObject({ stage: 'qualified', convertedOpportunityId: null });
  });

  it('needs a reason and a note for lost and on_hold; staff cannot reopen a lost lead, while manager/head/founder with write scope can', async () => {
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
      allowedMoves: [],
      canEdit: true,
    });
    // Staff-level sales still gets 403 on reopen.
    const reopen = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 2,
      contactActivity: CONTACT,
    });
    expect(reopen.status).toBe(403);

    // Founder (with write scope) can reopen a lost lead.
    h.as('boss', 'founder');
    const reopened = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 2,
      contactActivity: CONTACT,
    });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(dto(reopened.body)).toMatchObject({
      stage: 'contacted',
      stageReason: null,
      stageNote: null,
      lostReason: null,
    });
  });

  it('logs a contact activity atomically on any move to contacted, and refuses it on a stale version or another target stage without writing', async () => {
    const lead = await seed();

    // A stale expectedVersion rolls back without writing the contact activity.
    const stale = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 99,
      contactActivity: { kind: 'call', body: 'Should not persist on stale version' },
    });
    expect(stale.status).toBe(409);
    const afterStale = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(afterStale.some((a) => a.kind === 'call' || a.kind === 'email')).toBe(false);

    const res = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 1,
      contactActivity: { kind: 'call', body: 'Introductory call went well' },
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body).stage).toBe('contacted');
    const logged = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(
      logged.some(
        (a) =>
          a.kind === 'call' &&
          a.subject === 'Initial call' &&
          a.body === 'Introductory call went well',
      ),
    ).toBe(true);
    expect(logged.some((a) => a.kind === 'stage_change')).toBe(true);

    // FR-6 (D48): the resume from on_hold -> contacted may log a contact too, in the same request.
    const held = await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'waiting',
      expectedVersion: 2,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const resumed = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 3,
      contactActivity: { kind: 'email', body: 'Followed up after the hold' },
    });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(dto(resumed.body)).toMatchObject({ stage: 'contacted', version: 4 });
    const afterResume = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(
      afterResume.filter((a) => a.kind === 'email' && a.body === 'Followed up after the hold'),
    ).toHaveLength(1);

    // A contact on a move to any other stage is refused at the edge (400) and writes nothing.
    const bad = await patchStage(lead.id, {
      stage: 'qualified',
      expectedVersion: 4,
      contactActivity: { kind: 'meeting', body: 'Should not persist on a move to qualified' },
    });
    expect(bad.status).toBe(400);
    const afterBad = await h.db.select().from(activities).where(eq(activities.leadId, lead.id));
    expect(afterBad.some((a) => a.kind === 'meeting')).toBe(false);
    const [row] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(row).toMatchObject({ stage: 'contacted', version: 4 });
  });

  it('clears the reason and note when a lead leaves on_hold', async () => {
    const lead = await seed();
    await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'next year',
      expectedVersion: 1,
    });
    // Held at new, so it resumes to new (F1-Q53).
    const back = await patchStage(lead.id, { stage: 'new', expectedVersion: 2 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(dto(back.body)).toMatchObject({
      stage: 'new',
      stageReason: null,
      stageNote: null,
      heldFromStage: null,
    });
  });

  it('resumes a held lead to the stage it was held at, and to nothing else (F1-Q53)', async () => {
    const lead = await seed();
    await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1, contactActivity: CONTACT });
    await patchStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
    const held = await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'next quarter',
      expectedVersion: 3,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    expect(dto(held.body)).toMatchObject({
      stage: 'on_hold',
      heldFromStage: 'qualified',
      allowedMoves: ['qualified'],
    });
    // The detail read agrees with the change's answer.
    const read = await request(baseUrl).get(`/v1/leads/${lead.id}`);
    expect(dto(read.body)).toMatchObject({
      heldFromStage: 'qualified',
      allowedMoves: ['qualified'],
    });

    // The old fixed stage (contacted) and any other edge out of on_hold are refused, and nothing changes.
    for (const stage of ['contacted', 'new']) {
      const wrong = await patchStage(lead.id, { stage, expectedVersion: 4 });
      expect(wrong.status, stage).toBe(409);
      expect(errorOf(wrong.body).message).toContain('resumes to qualified only');
    }
    const [still] = await h.db.select().from(leads).where(eq(leads.id, lead.id));
    expect(still).toMatchObject({ stage: 'on_hold', heldFromStage: 'qualified', version: 4 });

    const back = await patchStage(lead.id, { stage: 'qualified', expectedVersion: 4 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(dto(back.body)).toMatchObject({ stage: 'qualified', heldFromStage: null });

    // Stage history stays honest: one move from on_hold straight back to qualified.
    const history = await h.db
      .select({ subject: activities.subject })
      .from(activities)
      .where(eq(activities.leadId, lead.id));
    expect(history.map((r) => r.subject)).toContain('Stage changed from on_hold to qualified');
    expect(history.map((r) => r.subject)).not.toContain('Stage changed from on_hold to contacted');
  });

  it('resumes a lead held before F1-Q53 (no held stage recorded) to contacted, as before', async () => {
    const lead = await seed();
    await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1, contactActivity: CONTACT });
    await patchStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
    await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'next quarter',
      expectedVersion: 3,
    });
    // What a row held before migration 0100 looks like.
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx.update(leads).set({ heldFromStage: null }).where(eq(leads.id, lead.id)),
    );
    const read = dto((await request(baseUrl).get(`/v1/leads/${lead.id}`)).body);
    expect(read).toMatchObject({ heldFromStage: null, allowedMoves: ['contacted'] });
    expect((await patchStage(lead.id, { stage: 'qualified', expectedVersion: 4 })).status).toBe(
      409,
    );
    // The call logged with the first move to contacted is a done contact, so the resume needs no new one.
    const back = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 4 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(dto(back.body).stage).toBe('contacted');
  });

  it('keeps board moves in stage order (FR-6): no jump from new to qualified, held-at-new cannot skip ahead', async () => {
    const lead = await seed();
    expect((await patchStage(lead.id, { stage: 'qualified', expectedVersion: 1 })).status).toBe(
      409,
    );
    await patchStage(lead.id, { stage: 'on_hold', reason: 'r', note: 'n', expectedVersion: 1 });
    for (const stage of ['contacted', 'qualified']) {
      expect((await patchStage(lead.id, { stage, expectedVersion: 2 })).status, stage).toBe(409);
    }
    // FR-6 (D48): back at new, the lead moves on to contacted once a contact is logged with the move.
    const resumed = await patchStage(lead.id, { stage: 'new', expectedVersion: 2 });
    expect(resumed.status).toBe(200);
    const contacted = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 3,
      contactActivity: CONTACT,
    });
    expect(contacted.status, JSON.stringify(contacted.body)).toBe(200);
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
