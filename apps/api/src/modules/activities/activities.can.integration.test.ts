// Integration tests of the `can` flags on activity list rows (activity-can.ts): for each kind of caller, the flag
// the list reports agrees with what the complete, reschedule and cancel routes then do, on a real Postgres. Real:
// migrations, ActivitiesService, LeadsService (to make leads as their owner would), the RoleCache and the
// controller behind the production body parser and error filter. Faked: the request context and authz.assert,
// which runs the real can() on a principal built like the tenancy interceptor's (../leads/test/harness.ts `actAs`).
// Run: pnpm --filter @bos/api exec vitest run src/modules/activities/activities.can.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ActivityDtoSchema, LeadDtoSchema, type ActivityCan } from '@bos/contracts';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { z } from 'zod';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { NumberingService } from '../../platform/settings/numbering.service';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsService } from '../leads/leads.service';
import { LeadLostReasonsService } from '../leads/lost-reasons.service';
import { startHarness, type Harness } from '../leads/test/harness';
import type { PlannedChange } from './activity-can';
import { ActivitiesController } from './activities.controller';
import { ActivitiesService } from './activities.service';

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let leadsService: LeadsService;

const P = { sales: '', salesPeer: '', salesManager: '', finance: '', storeKeeper: '' };

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const authz = h.authz as unknown as AuthzService;
  const audit = new AuditService(h.db);
  leadsService = new LeadsService(
    h.db,
    authz,
    audit,
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, audit, h.caller),
    h.roleCache,
    h.notify,
  );
  const service = new ActivitiesService(h.db, authz, audit, h.caller, h.roleCache, h.notify);

  const sales = await h.department('Sales');
  P.sales = await h.member({ roles: ['sales'], departmentId: sales, displayName: 'Sita Sales' });
  P.salesPeer = await h.member({ roles: ['sales'], departmentId: sales, displayName: 'Ram Sales' });
  P.salesManager = await h.member({
    roles: ['sales'],
    departmentId: sales,
    level: 'manager',
    displayName: 'Maya Manager',
  });
  P.finance = await h.member({ roles: ['finance'], departmentId: await h.department('Finance') });
  P.storeKeeper = await h.member({
    roles: ['warehouse'],
    departmentId: await h.department('Warehouse'),
  });

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

// ---------------------------------------------------------------------------------------- helpers

const DUE_1 = '2030-01-01T09:00:00.000Z';
const DUE_2 = '2030-01-02T09:00:00.000Z';
const ACTIONS: readonly PlannedChange[] = ['complete', 'reschedule', 'cancel'];

const leadOf = async (owner: string) => {
  await h.actAs(owner);
  return LeadDtoSchema.parse(
    await leadsService.create({
      title: 'Website for Acme',
      source: 'referral',
      companyName: 'Acme Pvt. Ltd.',
      contactName: 'Sita Rai',
      currency: 'NPR',
    }),
  );
};

/** A planned call on `leadId`, created by the current caller; assigned to `assigneeUserId` when named. */
const plan = async (leadId: string, assigneeUserId?: string) => {
  const subject = `Call ${randomUUID()}`;
  const res = await request(baseUrl)
    .post('/v1/activities')
    .send({
      kind: 'call',
      subject,
      dueAt: DUE_1,
      leadId,
      ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
    });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return ActivityDtoSchema.parse(res.body);
};

/** The row as the current caller's unfiltered list shows it (the /activities page), or undefined when absent. */
const rowInList = async (subject: string, id: string) => {
  const res = await request(baseUrl).get(`/v1/activities?q=${encodeURIComponent(subject)}`);
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return z
    .array(ActivityDtoSchema)
    .parse(res.body)
    .find((a) => a.id === id);
};

const run = (id: string, what: PlannedChange, version: number) =>
  request(baseUrl)
    .patch(`/v1/activities/${id}/${what}`)
    // Reschedule moves the due time only: a new assignee is a separate 400 the flag does not cover.
    .send(
      what === 'reschedule'
        ? { expectedVersion: version, dueAt: DUE_2 }
        : { expectedVersion: version },
    );

/**
 * For each action, a fresh follow-up on a lead owned by Sita (assigned to `assignee`, else to her): the caller's
 * list flag must equal `expected`, and the route must allow exactly what the flag says. `expected` null means the
 * row is not on the caller's list and every route refuses it.
 */
async function expectFlagsAgree(
  caller: string,
  assignee: string | undefined,
  expected: ActivityCan | null,
): Promise<void> {
  const lead = await leadOf(P.sales);
  for (const what of ACTIONS) {
    await h.actAs(P.sales);
    const followUp = await plan(lead.id, assignee);
    await h.actAs(caller);
    const row = await rowInList(followUp.subject, followUp.id);
    const res = await run(followUp.id, what, followUp.version);
    if (expected === null) {
      expect(row, `${what}: listed`).toBeUndefined();
      expect([403, 404], `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(
        res.status,
      );
      continue;
    }
    expect(row?.can, `${what}: flags`).toEqual(expected);
    if (expected[what]) {
      expect(res.status, `${what}: ${JSON.stringify(res.body)}`).toBe(200);
    } else {
      expect([403, 404], `${what}: ${res.status} ${JSON.stringify(res.body)}`).toContain(
        res.status,
      );
    }
  }
}

const ALL: ActivityCan = { complete: true, reschedule: true, cancel: true };
const NONE: ActivityCan = { complete: false, reschedule: false, cancel: false };

// ------------------------------------------------------------------------------------------- tests

describe('activity list rows carry the caller’s can flags, matching the write routes', () => {
  it('gives the lead owner every action on their own follow-up', async () => {
    await expectFlagsAgree(P.sales, undefined, ALL);
  });

  it('gives an assignee who can only read the lead Complete alone; Reschedule and Cancel answer 403', async () => {
    await expectFlagsAgree(P.salesPeer, P.salesPeer, {
      complete: true,
      reschedule: false,
      cancel: false,
    });
    // The refusals are the 403 the assignee gets, not a 404: the follow-up is on their own list.
    const lead = await leadOf(P.sales);
    const followUp = await plan(lead.id, P.salesPeer);
    await h.actAs(P.salesPeer);
    expect((await run(followUp.id, 'reschedule', 1)).status).toBe(403);
    expect((await run(followUp.id, 'cancel', 1)).status).toBe(403);
  });

  it('agrees with the routes for a Sales manager of the same department', async () => {
    await h.actAs(P.salesManager);
    // A manager's department write reaches a team member's lead.
    expect(h.caller.current().principal.grants.get('crm.lead.write')).toBe('department');
    await expectFlagsAgree(P.salesManager, undefined, ALL);
  });

  it('lists the row for someone who reads every lead but writes only their own, with no actions (404 on each)', async () => {
    await h.actAs(P.finance);
    const grants = h.caller.current().principal.grants;
    expect(grants.get('crm.lead.read')).toBe('all');
    expect(grants.get('crm.lead.write')).toBe('own');
    await expectFlagsAgree(P.finance, undefined, NONE);
    // Each refusal is the out-of-scope 404, not a 403.
    const lead = await leadOf(P.sales);
    const followUp = await plan(lead.id);
    await h.actAs(P.finance);
    for (const what of ACTIONS) expect((await run(followUp.id, what, 1)).status).toBe(404);
  });

  it('keeps the row off an unrelated user’s list, and every route refuses it', async () => {
    await expectFlagsAgree(P.storeKeeper, undefined, null);
    // No lead grant at all is a 403 no_permission, as before; only a grant out of scope is a 404.
    const lead = await leadOf(P.sales);
    const followUp = await plan(lead.id);
    await h.actAs(P.storeKeeper);
    for (const what of ACTIONS) {
      const res = await run(followUp.id, what, 1);
      expect(res.status).toBe(403);
      expect((res.body as { error: { reason?: string } }).error.reason).toBe('no_permission');
    }
  });

  it('reports no actions on a logged activity, even for its owner', async () => {
    const lead = await leadOf(P.sales);
    const res = await request(baseUrl)
      .post('/v1/activities')
      .send({ kind: 'note', subject: `Note ${randomUUID()}`, leadId: lead.id });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    const note = ActivityDtoSchema.parse(res.body);
    expect((await rowInList(note.subject, note.id))?.can).toEqual(NONE);
    expect((await run(note.id, 'complete', note.version)).status).toBe(409);
  });

  it('leaves can out of the write responses', async () => {
    const lead = await leadOf(P.sales);
    const followUp = await plan(lead.id);
    expect(followUp.can).toBeUndefined();
  });
});
