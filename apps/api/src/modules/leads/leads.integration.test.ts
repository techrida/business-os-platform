// Integration tests of the leads API on a real Postgres (Testcontainers, needs Docker in WSL). Real: migrations,
// LeadsService, NumberingService, AuditService, and the controller behind the production body parser and error
// filter. Faked: the request context and authz.assert (see test/harness.ts). Every response is parsed with the
// contract schema the workspace uses.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads
import 'reflect-metadata';

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
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
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
    expect((await patchStage(moved.id, { stage: 'contacted', expectedVersion: 1 })).status).toBe(
      200,
    );
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
    await patchStage(two.id, { stage: 'contacted', expectedVersion: 1 });

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
      (await patchStage(lead.id, { stage: 'lost', reason: 'price', expectedVersion: 1 })).status,
    ).toBe(400);
    const lost = await patchStage(lead.id, {
      stage: 'lost',
      reason: 'price',
      note: 'too dear',
      expectedVersion: 1,
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    expect(dto(lost.body)).toMatchObject({ stageReason: 'price', stageNote: 'too dear' });
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
