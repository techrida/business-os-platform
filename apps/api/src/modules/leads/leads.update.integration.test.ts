// Integration tests of the lead edit (PATCH /v1/leads/:id) and the owner options (GET /v1/leads/owners) on a real
// Postgres (Testcontainers, needs Docker in WSL). Real: migrations, LeadsService, AuditService, the users directory
// rows (users, user_entities, user_roles) and the controller behind the production body parser and error filter.
// Faked: the request context and authz.assert (see test/harness.ts).
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/leads.update.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { ErrorBodySchema, LeadDtoSchema, LeadOwnerOptionSchema } from '@bos/contracts';
import {
  activities,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  leads,
  opportunities,
  userEntities,
  userRoles,
  users,
} from '@bos/db';
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
import { NumberingService } from '../../platform/settings/numbering.service';
import { ErrorBodyFilter } from '../../platform/tenancy/error-body.filter';
import { LeadsController } from './leads.controller';
import { LeadsService } from './leads.service';
import { startHarness, type Harness } from './test/harness';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type AppPool = Parameters<typeof createParty>[0];

let h: Harness;
let app: INestApplication;
let baseUrl: string;
/** Active, holds `sales` in entity A, but switched off. */
let inactiveSales: string;
/** A user of another tenant. */
let foreignUser: string;
/** A customer's portal user of this tenant. */
let portalUser: string;

const sys = () => systemActor('test');

beforeAll(async () => {
  h = await startHarness({ Pool, drizzle });
  const service = new LeadsService(
    h.db,
    h.authz as unknown as AuthzService,
    new AuditService(h.db),
    new NumberingService(),
    h.caller,
    new CurrencyEnabledService(new SettingsService(h.db)),
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

  // The directory rows the owners list reads: both salespeople hold `sales`; boss and viewer hold no role rows.
  const pool = h.appPool as unknown as AppPool;
  await withTx(h.db, h.scopeA, sys(), (tx) =>
    tx.insert(userRoles).values([
      { tenantId: h.tenantId, userId: h.users.salesA, roleKey: 'sales' },
      { tenantId: h.tenantId, userId: h.users.salesB, roleKey: 'sales' },
      { tenantId: h.tenantId, userId: h.users.viewer, roleKey: 'management' },
    ]),
  );
  const [salesRow] = await withTx(h.db, h.scopeA, sys(), (tx) =>
    tx.select({ idpOrgId: users.idpOrgId }).from(users).where(eq(users.id, h.users.salesA)),
  );
  inactiveSales = (
    await createStaffUser(pool, { ...h.scopeA, idpOrgId: salesRow!.idpOrgId, roleKeys: ['sales'] })
  ).userId;
  await withTx(h.db, h.scopeA, sys(), (tx) =>
    tx.update(users).set({ status: 'inactive' }).where(eq(users.id, inactiveSales)),
  );
  const customerParty = await createParty(pool, { tenantId: h.tenantId, kind: 'customer' });
  portalUser = (
    await createPortalUser(pool, { tenantId: h.tenantId, idpOrgId: customerParty.idpOrgId })
  ).userId;
  const other = await createTenantWithEntity(pool);
  foreignUser = (
    await createStaffUser(pool, {
      tenantId: other.tenantId,
      organizationId: other.organizationId,
      idpOrgId: other.idpOrgId,
      roleKeys: ['sales'],
    })
  ).userId;
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
  currency: 'USD',
};

const dto = (body: unknown) => LeadDtoSchema.parse(body);
const errorOf = (body: unknown) => ErrorBodySchema.parse(body).error;
const patch = (id: string, body: Record<string, unknown>) =>
  request(baseUrl).patch(`/v1/leads/${id}`).send(body);
const owners = async () => {
  const res = await request(baseUrl).get('/v1/leads/owners');
  expect(res.status, JSON.stringify(res.body)).toBe(200);
  return LeadOwnerOptionSchema.array().parse(res.body);
};
const rowOf = async (id: string) => {
  const [row] = await h.db.select().from(leads).where(eq(leads.id, id));
  return row!;
};
const actionsOf = async (id: string) => (await h.auditOf(id)).map((e) => e.action);

async function seed(extra: Record<string, unknown> = {}) {
  const res = await request(baseUrl)
    .post('/v1/leads')
    .send({ ...BODY, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return dto(res.body);
}

describe('PATCH /v1/leads/:id', () => {
  it('changes only the fields sent, normalises the email, bumps the version and audits before and after', async () => {
    const lead = await seed({ expectedValue: '1000' });
    const res = await patch(lead.id, {
      title: 'Website and app for Acme',
      email: 'Sita@Acme.Example',
      expectedValue: '1000.00',
      expectedVersion: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const after = dto(res.body);
    expect(after).toMatchObject({
      title: 'Website and app for Acme',
      email: 'sita@acme.example',
      expectedValue: '1000.00',
      companyName: 'Acme Pvt. Ltd.',
      currency: 'USD',
      ownerUserId: h.users.salesA,
      version: 2,
    });
    const actions = await actionsOf(lead.id);
    expect(actions).toContain('lead.updated');
    expect(actions).not.toContain('lead.owner_changed');
    const { rows } = await h.ownerPool.query(
      `SELECT before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND action = 'lead.updated'`,
      [h.tenantId, lead.id],
    );
    // An equal amount written differently is not a change.
    expect(rows).toEqual([
      {
        before: { title: 'Website for Acme', email: null },
        after: { title: 'Website and app for Acme', email: 'sita@acme.example' },
      },
    ]);
  });

  it('an own-scope user cannot hand a lead to someone else: 403 and the lead is unchanged', async () => {
    const lead = await seed();
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: h.users.salesA, version: 1 });
    expect(await actionsOf(lead.id)).not.toContain('lead.updated');
  });

  it('a wider grant reassigns: owner-only edit keeps the currency, and both audits are written', async () => {
    const lead = await seed();
    h.as('boss', 'founder');
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({
      ownerUserId: h.users.salesB,
      currency: 'USD',
      version: 2,
    });
    const actions = await actionsOf(lead.id);
    expect(actions).toContain('lead.updated');
    expect(actions).toContain('lead.owner_changed');
    const { rows } = await h.ownerPool.query(
      `SELECT before, after FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_id = $2 AND action = 'lead.owner_changed'`,
      [h.tenantId, lead.id],
    );
    expect(rows).toEqual([
      { before: { ownerUserId: h.users.salesA }, after: { ownerUserId: h.users.salesB } },
    ]);
  });

  it('refuses an owner who is not an active staff member of this entity with 400', async () => {
    const lead = await seed();
    h.as('boss', 'founder');
    for (const ownerUserId of [randomUUID(), foreignUser, inactiveSales, portalUser]) {
      const res = await patch(lead.id, { ownerUserId, expectedVersion: 1 });
      expect(res.status, JSON.stringify(res.body)).toBe(400);
      expect(errorOf(res.body).message).toBe(
        'ownerUserId is not an active staff member of this entity',
      );
    }
    expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: h.users.salesA, version: 1 });
  });

  it('refuses a converted lead with 400', async () => {
    const lead = await seed();
    const customerId = await h.seedCustomer();
    await withTx(h.db, h.scopeA, sys(), async (tx) => {
      const [opp] = await tx
        .insert(opportunities)
        .values({ ...h.scopeA, number: `OP-${lead.id.slice(0, 8)}`, name: 'Acme', customerId })
        .returning({ id: opportunities.id });
      await tx
        .update(leads)
        .set({ stage: 'converted', convertedOpportunityId: opp!.id, customerId })
        .where(eq(leads.id, lead.id));
    });
    const res = await patch(lead.id, { title: 'Too late', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((await rowOf(lead.id)).title).toBe(BODY.title);
  });

  it('refuses a stale version with 409, even when the edit would change nothing', async () => {
    const lead = await seed();
    expect((await patch(lead.id, { title: 'First', expectedVersion: 1 })).status).toBe(200);
    expect((await patch(lead.id, { title: 'Second', expectedVersion: 1 })).status).toBe(409);
    expect((await patch(lead.id, { title: 'First', expectedVersion: 1 })).status).toBe(409);
    expect(await rowOf(lead.id)).toMatchObject({ title: 'First', version: 2 });
  });

  it('refuses an edit that changes nothing with 400', async () => {
    const lead = await seed();
    const res = await patch(lead.id, {
      title: BODY.title,
      currency: 'USD',
      ownerUserId: h.users.salesA,
      expectedVersion: 1,
    });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect((await rowOf(lead.id)).version).toBe(1);
  });

  it('answers 404 for a lead outside the caller scope or entity', async () => {
    const lead = await seed();
    h.as('salesB', 'sales');
    expect((await patch(lead.id, { title: 'Mine now', expectedVersion: 1 })).status).toBe(404);
    h.as('salesA', 'sales', 'B');
    expect((await patch(lead.id, { title: 'Mine now', expectedVersion: 1 })).status).toBe(404);
    expect((await rowOf(lead.id)).title).toBe(BODY.title);
  });
});

describe('GET /v1/leads/owners', () => {
  it('offers an own-scope caller only themselves', async () => {
    const list = await owners();
    expect(list.map((o) => o.userId)).toEqual([h.users.salesA]);
  });

  it('offers a wide-scope caller every active user whose roles may own a lead, and nobody else', async () => {
    h.as('boss', 'founder');
    const ids = (await owners()).map((o) => o.userId);
    expect(ids).toEqual(expect.arrayContaining([h.users.boss, h.users.salesA, h.users.salesB]));
    // management has no crm.lead.write; an inactive user and another tenant's user are never offered.
    expect(ids).not.toContain(h.users.viewer);
    expect(ids).not.toContain(inactiveSales);
    expect(ids).not.toContain(foreignUser);
    expect(ids).toHaveLength(3);
  });

  it('follows the membership: roles narrowed away in this entity do not count', async () => {
    h.as('boss', 'founder');
    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx
        .update(userEntities)
        .set({ roleKeys: ['management'] })
        .where(
          and(
            eq(userEntities.userId, h.users.salesB),
            eq(userEntities.organizationId, h.scopeA.organizationId),
          ),
        ),
    );
    try {
      expect((await owners()).map((o) => o.userId)).not.toContain(h.users.salesB);
    } finally {
      await withTx(h.db, h.scopeA, sys(), (tx) =>
        tx
          .update(userEntities)
          .set({ roleKeys: null })
          .where(eq(userEntities.userId, h.users.salesB)),
      );
    }
  });
});

/** A planned call (or the given kind) on `leadId`, assigned to `assigneeUserId`; `done` marks it completed or cancelled. */
async function plan(
  leadId: string,
  assigneeUserId: string | null,
  extra: { kind?: 'call' | 'meeting' | 'email'; done?: 'completed' | 'cancelled' } = {},
) {
  const now = new Date();
  const [row] = await withTx(h.db, h.scopeA, sys(), (tx) =>
    tx
      .insert(activities)
      .values({
        ...h.scopeA,
        kind: extra.kind ?? 'call',
        subject: 'Follow up',
        leadId,
        dueAt: new Date(Date.now() + 86_400_000),
        assigneeUserId,
        createdByUserId: h.users.salesA,
        completedAt: extra.done === 'completed' ? now : null,
        cancelledAt: extra.done === 'cancelled' ? now : null,
      })
      .returning(),
  );
  return row!;
}
const activityRow = async (id: string) => {
  const [row] = await h.db.select().from(activities).where(eq(activities.id, id));
  return row!;
};

describe('D45: follow-ups follow the owner (PATCH /v1/leads/:id)', () => {
  it('moves the open follow-ups of the old owner to the new owner, audited, and leaves everything else', async () => {
    const lead = await seed();
    const mine = await plan(lead.id, h.users.salesA);
    const myMeeting = await plan(lead.id, h.users.salesA, { kind: 'meeting' });
    const theirs = await plan(lead.id, h.users.boss);
    const unassigned = await plan(lead.id, null);
    const completed = await plan(lead.id, h.users.salesA, { done: 'completed' });
    const cancelled = await plan(lead.id, h.users.salesA, { done: 'cancelled' });
    const otherLead = await seed();
    const onOtherLead = await plan(otherLead.id, h.users.salesA);

    h.as('boss', 'founder');
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);

    expect(await activityRow(mine.id)).toMatchObject({ assigneeUserId: h.users.salesB, version: 2 });
    expect(await activityRow(myMeeting.id)).toMatchObject({ assigneeUserId: h.users.salesB });
    for (const row of [theirs, unassigned, completed, cancelled, onOtherLead]) {
      const after = await activityRow(row.id);
      expect(after.assigneeUserId, row.id).toBe(row.assigneeUserId);
      expect(after.version, row.id).toBe(row.version);
    }
    expect(dto(res.body).nextFollowUpAt).not.toBeNull();
    const { rows } = await h.ownerPool.query(
      `SELECT entity_id, before, after, meta FROM audit.audit_events
        WHERE tenant_id = $1 AND action = 'activity.reassigned' ORDER BY entity_id`,
      [h.tenantId],
    );
    expect((rows as { entity_id: string }[]).map((r) => r.entity_id).sort()).toEqual(
      [mine.id, myMeeting.id].sort(),
    );
    for (const r of rows as { before: unknown; after: unknown; meta: unknown }[]) {
      expect(r.before).toEqual({ assigneeUserId: h.users.salesA });
      expect(r.after).toEqual({ assigneeUserId: h.users.salesB });
      expect(r.meta).toEqual({ reason: 'lead_owner_changed', leadId: lead.id });
    }
  });

  it('an own-scope old owner cannot hand the lead on, so nothing moves', async () => {
    const lead = await seed();
    const mine = await plan(lead.id, h.users.salesA);
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(403);
    expect(await activityRow(mine.id)).toMatchObject({ assigneeUserId: h.users.salesA, version: 1 });
  });

  it('an edit that does not change the owner moves nothing', async () => {
    const lead = await seed();
    const mine = await plan(lead.id, h.users.salesA);
    h.as('boss', 'founder');
    const res = await patch(lead.id, { title: 'Renamed', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await activityRow(mine.id)).toMatchObject({ assigneeUserId: h.users.salesA, version: 1 });
  });

  it('a lead without an owner leaves its unassigned follow-ups unassigned when it gets one', async () => {
    const lead = await seed();
    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx.update(leads).set({ ownerUserId: null }).where(eq(leads.id, lead.id)),
    );
    const unassigned = await plan(lead.id, null);
    h.as('boss', 'founder');
    const row = await rowOf(lead.id);
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: row.version });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect((await activityRow(unassigned.id)).assigneeUserId).toBeNull();
  });
});

describe("D46: the lead carries its owner's display name and nothing more of the directory", () => {
  const NAMES = {
    salesA: { name: 'Sita Sales', email: 'sita.private@crestia.example' },
    boss: { name: 'Fiona Founder', email: 'fiona.private@crestia.example' },
  } as const;
  beforeAll(async () => {
    for (const key of ['salesA', 'boss'] as const) {
      await withTx(h.db, h.scopeA, sys(), (tx) =>
        tx
          .update(users)
          .set({ displayName: NAMES[key].name, email: NAMES[key].email })
          .where(eq(users.id, h.users[key])),
      );
    }
  });

  it('shows the owner by name on create, detail and list, and Sales never reaches a Founder-owned lead', async () => {
    const lead = await seed();
    expect(lead.ownerName).toBe('Sita Sales');
    const got = await request(baseUrl).get(`/v1/leads/${lead.id}`);
    expect(got.status, JSON.stringify(got.body)).toBe(200);
    expect(dto(got.body).ownerName).toBe('Sita Sales');
    const all = LeadDtoSchema.array().parse((await request(baseUrl).get('/v1/leads')).body);
    expect(all.find((l) => l.id === lead.id)?.ownerName).toBe('Sita Sales');
    h.as('boss', 'founder');
    const founderLead = await seed();
    expect(founderLead.ownerName).toBe('Fiona Founder');
    h.as('salesA', 'sales');
    expect((await request(baseUrl).get(`/v1/leads/${founderLead.id}`)).status).toBe(404);
  });

  it('puts no address in the payload of any route that returns the lead', async () => {
    const lead = await seed();
    h.as('boss', 'founder');
    const edited = await patch(lead.id, { ownerUserId: h.users.boss, expectedVersion: 1 });
    const bodies = [
      JSON.stringify(edited.body),
      JSON.stringify((await request(baseUrl).get('/v1/leads')).body),
      JSON.stringify((await request(baseUrl).get(`/v1/leads/${lead.id}`)).body),
    ];
    for (const text of bodies) expect(text).not.toMatch(/@crestia\.example/);
    expect(dto(edited.body).ownerName).toBe('Fiona Founder');
  });

  it('reads "Unnamed user" for an owner with neither name nor address, and null for no owner', async () => {
    const lead = await seed();
    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx.update(users).set({ displayName: null, email: null }).where(eq(users.id, h.users.salesB)),
    );
    h.as('boss', 'founder');
    const handed = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(dto(handed.body).ownerName).toBe('Unnamed user');
    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx.update(leads).set({ ownerUserId: null }).where(eq(leads.id, lead.id)),
    );
    const got = await request(baseUrl).get(`/v1/leads/${lead.id}`);
    expect(dto(got.body)).toMatchObject({ ownerUserId: null, ownerName: null });
  });
});
