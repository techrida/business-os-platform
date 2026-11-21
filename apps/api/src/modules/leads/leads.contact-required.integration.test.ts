// Integration tests of the mark-contacted rule (FR-6, D48) on a real Postgres (Testcontainers, needs Docker in WSL):
// every move to contacted (new -> contacted, the resume of a hold with no recorded stage, a manager's reopen of a lost
// lead) needs a contact, logged in the same request or already done on the lead, else 409
// `contact_activity_required`. A planned follow-up, a cancelled one and a note are not a contact. Real: migrations,
// LeadsService, AuditService and the controller behind the production body parser and error filter. Faked: the request
// context and authz.assert (see test/harness.ts).
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/leads.contact-required.integration.test.ts
import 'reflect-metadata';

import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LeadDtoSchema } from '@bos/contracts';
import { activities, leads } from '@bos/db';
import { type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../app.setup';
import { AuditService } from '../../platform/audit/audit.service';
import type { AuthzService } from '../../platform/authz/authz.service';
import { systemActor, withTx } from '../../platform/db/tx';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { NumberingService } from '../../platform/settings/numbering.service';
import { SettingsService } from '../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsController } from './leads.controller';
import { CONTACT_REQUIRED_MESSAGE, LeadsService } from './leads.service';
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness } from './test/harness';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let h: Harness;
let app: INestApplication;
let baseUrl: string;

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const audit = new AuditService(h.db);
  const service = new LeadsService(
    h.db,
    h.authz as unknown as AuthzService,
    audit,
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
    new LeadLostReasonsService(h.db, audit, h.caller),
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
};

const dto = (body: unknown) => LeadDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const patchStage = (id: string, body: Record<string, unknown>) =>
  request(baseUrl).patch(`/v1/leads/${id}/stage`).send(body);

async function seed() {
  const res = await request(baseUrl).post('/v1/leads').send(BODY);
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dto(res.body);
}

async function stageOf(id: string) {
  const [row] = await h.db.select().from(leads).where(eq(leads.id, id));
  return row!;
}

async function activitiesOf(id: string) {
  return h.db.select().from(activities).where(eq(activities.leadId, id));
}

/** Writes an activity row on the lead directly, the way the activities service stores it. */
async function addActivity(
  leadId: string,
  row: {
    kind: 'call' | 'email' | 'meeting' | 'note';
    dueAt?: Date;
    completedAt?: Date;
    cancelledAt?: Date;
  },
) {
  await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
    tx.insert(activities).values({
      ...h.scopeA,
      kind: row.kind,
      subject: `A ${row.kind}`,
      leadId,
      dueAt: row.dueAt ?? null,
      completedAt: row.completedAt ?? null,
      cancelledAt: row.cancelledAt ?? null,
    }),
  );
}

/** A refusal of the rule: 409, the code, the message, and the lead left as it was. */
async function expectRefused(
  res: request.Response,
  id: string,
  stage: string,
  version: number,
): Promise<void> {
  expect(res.status, JSON.stringify(res.body)).toBe(409);
  expect(errorOf(res.body)).toMatchObject({
    code: 'contact_activity_required',
    message: CONTACT_REQUIRED_MESSAGE,
  });
  expect(await stageOf(id)).toMatchObject({ stage, version });
}

async function stageChangedMeta(id: string): Promise<Record<string, unknown>[]> {
  const { rows } = await h.ownerPool.query(
    `SELECT meta FROM audit.audit_events
      WHERE tenant_id = $1 AND entity_id = $2 AND action = 'lead.stage_changed' ORDER BY id`,
    [h.tenantId, id],
  );
  return (rows as { meta: Record<string, unknown> }[]).map((r) => r.meta);
}

describe('FR-6 mark contacted: new -> contacted', () => {
  it('refuses the move with no contact logged or done, and writes nothing', async () => {
    const lead = await seed();
    await expectRefused(
      await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 }),
      lead.id,
      'new',
      1,
    );
    expect(await activitiesOf(lead.id)).toHaveLength(0);
  });

  it.each([
    ['call', 'Initial call'],
    ['email', 'Initial email'],
    ['meeting', 'Initial meeting'],
  ] as const)(
    'moves with a %s logged in the same request: one %s row, one stage_change row, audited',
    async (kind, subject) => {
      const lead = await seed();
      const res = await patchStage(lead.id, {
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind, body: 'Spoke with the buyer' },
      });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      expect(dto(res.body)).toMatchObject({ stage: 'contacted', version: 2 });
      const rows = await activitiesOf(lead.id);
      expect(rows.filter((a) => a.kind === kind)).toEqual([
        expect.objectContaining({ subject, body: 'Spoke with the buyer', dueAt: null }),
      ]);
      expect(rows.filter((a) => a.kind === 'stage_change')).toHaveLength(1);
      expect(rows).toHaveLength(2);
      expect(await stageChangedMeta(lead.id)).toEqual([
        expect.objectContaining({ loggedContact: true }),
      ]);
    },
  );

  it('moves without a body activity when the lead already has a done call', async () => {
    const lead = await seed();
    await addActivity(lead.id, { kind: 'call' });
    const res = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body).stage).toBe('contacted');
    const meta = await stageChangedMeta(lead.id);
    expect(meta).toHaveLength(1);
    expect(meta[0]).not.toHaveProperty('loggedContact');
  });

  it('counts a completed follow-up as a contact', async () => {
    const lead = await seed();
    await addActivity(lead.id, {
      kind: 'meeting',
      dueAt: new Date(Date.now() + 86_400_000),
      completedAt: new Date(),
    });
    const res = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
  });

  it('does not count a planned future call, an overdue planned call, a cancelled call or a note', async () => {
    const lead = await seed();
    await addActivity(lead.id, { kind: 'call', dueAt: new Date(Date.now() + 86_400_000) });
    await addActivity(lead.id, { kind: 'email', dueAt: new Date(Date.now() - 86_400_000) });
    await addActivity(lead.id, { kind: 'call', cancelledAt: new Date() });
    await addActivity(lead.id, { kind: 'note' });
    await expectRefused(
      await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 }),
      lead.id,
      'new',
      1,
    );
  });

  it('allows new -> lost and new -> on_hold without a contact', async () => {
    const toLost = await seed();
    const lost = await patchStage(toLost.id, {
      stage: 'lost',
      newLostReason: 'Went quiet before any contact',
      note: 'no reply',
      expectedVersion: 1,
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);

    const toHold = await seed();
    const held = await patchStage(toHold.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'next year',
      expectedVersion: 1,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
  });

  it('lets one of two identical concurrent moves through, leaving one contact and one stage_change', async () => {
    const lead = await seed();
    const move = () =>
      patchStage(lead.id, {
        stage: 'contacted',
        expectedVersion: 1,
        contactActivity: { kind: 'call', body: 'Intro call' },
      });
    const [a, b] = await Promise.all([move(), move()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const rows = await activitiesOf(lead.id);
    expect(rows.filter((r) => r.kind === 'stage_change')).toHaveLength(1);
    expect(rows.filter((r) => r.kind === 'call')).toHaveLength(1);
    expect(await stageOf(lead.id)).toMatchObject({ stage: 'contacted', version: 2 });
  });
});

describe('FR-6 mark contacted: resume from on_hold', () => {
  it('resumes a lead held at new to new, with no contact needed', async () => {
    const lead = await seed();
    await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'later',
      expectedVersion: 1,
    });
    const back = await patchStage(lead.id, { stage: 'new', expectedVersion: 2 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
    expect(dto(back.body).stage).toBe('new');
  });

  it('refuses a legacy hold (no held stage) resuming to contacted until a contact is done or logged', async () => {
    const legacyHold = async () => {
      const lead = await seed();
      const held = await patchStage(lead.id, {
        stage: 'on_hold',
        reason: 'budget',
        note: 'later',
        expectedVersion: 1,
      });
      expect(held.status, JSON.stringify(held.body)).toBe(200);
      // What a row held before migration 0100 looks like.
      await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        tx.update(leads).set({ heldFromStage: null }).where(eq(leads.id, lead.id)),
      );
      return lead.id;
    };

    const first = await legacyHold();
    await expectRefused(
      await patchStage(first, { stage: 'contacted', expectedVersion: 2 }),
      first,
      'on_hold',
      2,
    );
    await addActivity(first, { kind: 'email' });
    const resumed = await patchStage(first, { stage: 'contacted', expectedVersion: 2 });
    expect(resumed.status, JSON.stringify(resumed.body)).toBe(200);
    expect(dto(resumed.body).stage).toBe('contacted');

    // The same request may log the contact on the resume.
    const second = await legacyHold();
    const logged = await patchStage(second, {
      stage: 'contacted',
      expectedVersion: 2,
      contactActivity: { kind: 'meeting', body: 'Met again' },
    });
    expect(logged.status, JSON.stringify(logged.body)).toBe(200);
    expect((await activitiesOf(second)).filter((a) => a.kind === 'meeting')).toHaveLength(1);
  });
});

describe('FR-6 mark contacted: manager reopen of a lost lead', () => {
  const loseFromNew = async () => {
    const lead = await seed();
    const lost = await patchStage(lead.id, {
      stage: 'lost',
      newLostReason: `Lost before contact ${lead.id}`,
      note: 'no reply',
      expectedVersion: 1,
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    return lead.id;
  };

  it('refuses the reopen when the lead was never contacted', async () => {
    const id = await loseFromNew();
    h.as('boss', 'founder');
    await expectRefused(
      await patchStage(id, { stage: 'contacted', expectedVersion: 2 }),
      id,
      'lost',
      2,
    );
  });

  it('reopens when the lead has a prior contact', async () => {
    const lead = await seed();
    const moved = await patchStage(lead.id, {
      stage: 'contacted',
      expectedVersion: 1,
      contactActivity: { kind: 'call', body: 'First call' },
    });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    const lost = await patchStage(lead.id, {
      stage: 'lost',
      newLostReason: `Chose another vendor ${lead.id}`,
      note: 'price',
      expectedVersion: 2,
    });
    expect(lost.status, JSON.stringify(lost.body)).toBe(200);
    h.as('boss', 'founder');
    const reopened = await patchStage(lead.id, { stage: 'contacted', expectedVersion: 3 });
    expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
    expect(dto(reopened.body).stage).toBe('contacted');
  });

  it('still answers a staff reopen with 403 before the contact rule', async () => {
    const id = await loseFromNew();
    expect((await patchStage(id, { stage: 'contacted', expectedVersion: 2 })).status).toBe(403);
  });
});

describe('FR-6 mark contacted: later stages', () => {
  it('does not apply to moves out of contacted or qualified', async () => {
    const lead = await seed();
    await addActivity(lead.id, { kind: 'call' });
    expect((await patchStage(lead.id, { stage: 'contacted', expectedVersion: 1 })).status).toBe(
      200,
    );
    // Take the contact away: later moves do not look for one.
    await withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
      tx
        .update(activities)
        .set({ cancelledAt: new Date() })
        .where(and(eq(activities.leadId, lead.id), eq(activities.kind, 'call'))),
    );
    const qualified = await patchStage(lead.id, { stage: 'qualified', expectedVersion: 2 });
    expect(qualified.status, JSON.stringify(qualified.body)).toBe(200);
    const held = await patchStage(lead.id, {
      stage: 'on_hold',
      reason: 'budget',
      note: 'later',
      expectedVersion: 3,
    });
    expect(held.status, JSON.stringify(held.body)).toBe(200);
    const back = await patchStage(lead.id, { stage: 'qualified', expectedVersion: 4 });
    expect(back.status, JSON.stringify(back.body)).toBe(200);
  });
});
