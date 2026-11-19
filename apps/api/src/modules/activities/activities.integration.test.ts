// Integration tests of the activities API on a real Postgres (Testcontainers, needs Docker in WSL). Real:
// migrations, ActivitiesService, LeadsService (to make lead subjects), NumberingService, AuditService, and the
// controller behind the production body parser and error filter. Faked: the request context and authz.assert
// (see ../leads/test/harness.ts). Responses are parsed with the contract schema the workspace uses.
// Run: pnpm --filter @bos/api exec vitest run src/modules/activities
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ActivityDtoSchema, ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { activities } from '@bos/db';
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
import { LeadsService } from '../leads/leads.service';
import { startHarness, type Harness } from '../leads/test/harness';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

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
  );
  const service = new ActivitiesService(h.db, authz, new AuditService(h.db), h.caller);
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
  currency: 'NPR' as const,
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
    await post({ kind: 'task', subject: 'Unrelated', leadId: lead.id });

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
