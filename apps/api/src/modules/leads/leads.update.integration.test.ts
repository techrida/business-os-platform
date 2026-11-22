// Integration tests of the lead edit (PATCH /v1/leads/:id) and the owner options (GET /v1/leads/owners) on a real
// Postgres (Testcontainers, needs Docker in WSL). Real: migrations, LeadsService, AuditService, the users directory
// rows (users, user_entities, user_roles) and the controller behind the production body parser and error filter.
// Faked: the request context and authz.assert (see test/harness.ts). The D50 block acts as members with a department
// and level, whose grants come from the real RoleCache, and checks the rule's code from the service's 400.
// Run: pnpm --filter @bos/api exec vitest run src/modules/leads/leads.update.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  ASSIGNMENT_DENY_MESSAGES,
  CreateLeadBodySchema,
  ErrorBodySchema,
  LeadDtoSchema,
  LeadOwnerOptionSchema,
} from '@bos/contracts';
import {
  activities,
  createParty,
  createPortalUser,
  createStaffUser,
  createTenantWithEntity,
  leads,
  opportunities,
  userEntities,
  users,
} from '@bos/db';
import { BadRequestException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { and, eq, isNotNull } from 'drizzle-orm';
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
import { LeadLostReasonsService } from './lost-reasons.service';
import { startHarness, type Harness, WORKSPACE_URL } from './test/harness';
import { CurrencyEnabledService } from '../../platform/settings/currency-enabled';
import { SettingsService } from '../../platform/settings/settings.service';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

type AppPool = Parameters<typeof createParty>[0];

let h: Harness;
let app: INestApplication;
let baseUrl: string;
let service: LeadsService;
/** Active, holds `sales` in entity A, but switched off. */
let inactiveSales: string;
/** A user of another tenant. */
let foreignUser: string;
/** A customer's portal user of this tenant. */
let portalUser: string;

const sys = () => systemActor('test');

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

  // The harness gives the base users their role rows (salespeople `sales`, boss `founder`, viewer `management`).
  const pool = h.appPool as unknown as AppPool;
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
  country: 'NP',
  currency: 'USD',
  phones: [{ country: 'NP', e164: '+9779812345678', isPrimary: true }],
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

  it('a salesperson with no department cannot hand a lead to a colleague: 400 and the lead is unchanged', async () => {
    const lead = await seed();
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body).message).toBe(`ownerUserId ${ASSIGNMENT_DENY_MESSAGES.no_department}`);
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

  it('refuses an edit that would leave the lead with neither an email nor a phone (FX9), and changes nothing', async () => {
    // BODY has a phone and no email.
    const lead = await seed();
    const res = await patch(lead.id, { phones: [], expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body).message).toMatch(/email or at least one phone/);
    const read = dto((await request(baseUrl).get(`/v1/leads/${lead.id}`)).body);
    expect(read.version).toBe(1);
    expect(read.phones).toEqual([
      { country: 'NP', e164: '+9779812345678', label: null, isPrimary: true },
    ]);
    // With an email it may drop its numbers.
    const ok = await patch(lead.id, { email: 'sita@acme.example', phones: [], expectedVersion: 1 });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
    expect(dto(ok.body)).toMatchObject({ email: 'sita@acme.example', phones: [], version: 2 });
    expect((await rowOf(lead.id)).phonesSearch).toBeNull();
  });

  it('replaces the whole phone list on a phones-only edit, bumps the version, and leaves the list alone when phones is not sent', async () => {
    const lead = await seed();
    const phones = [
      { country: 'US', e164: '+12015550123', label: 'work', isPrimary: false },
      { country: 'NP', e164: '+9779801112233', label: 'mobile', isPrimary: true },
    ];
    const res = await patch(lead.id, { phones, country: 'US', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body)).toMatchObject({
      country: 'US',
      version: 2,
      phones: [phones[1], phones[0]],
    });
    expect((await rowOf(lead.id)).phonesSearch).toBe('+12015550123 +9779801112233');
    // The same list again is no change.
    expect((await patch(lead.id, { phones, expectedVersion: 2 })).status).toBe(400);
    const renamed = await patch(lead.id, { title: 'Renamed', expectedVersion: 2 });
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    expect(dto(renamed.body).phones).toEqual([phones[1], phones[0]]);
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
  it('offers a salesperson with no department only themselves', async () => {
    const list = await owners();
    expect(list.map((o) => o.userId)).toEqual([h.users.salesA]);
    // No picture set: the option still names the pointer, as null.
    expect(list[0]).toHaveProperty('avatarDocumentId', null);
  });

  it('offers the Founder every active staff member whose live grants read and write leads, and nobody else', async () => {
    h.as('boss', 'founder');
    const ids = (await owners()).map((o) => o.userId);
    // Management reads every lead but writes none, so it never owns one (the owner must read, D50 #21, and write).
    expect(new Set(ids)).toEqual(new Set([h.users.boss, h.users.salesA, h.users.salesB]));
    expect(ids).not.toContain(h.users.viewer);
    // An inactive user, a portal user and another tenant's user are never offered.
    expect(ids).not.toContain(inactiveSales);
    expect(ids).not.toContain(portalUser);
    expect(ids).not.toContain(foreignUser);
  });

  it('follows the membership: roles narrowed away in this entity do not count', async () => {
    h.as('boss', 'founder');
    // The membership narrows salesB's `sales` role away and adds none (it only intersects), so nothing reads leads.
    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx
        .update(userEntities)
        .set({ roleKeys: ['operations_head'] })
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

    expect(await activityRow(mine.id)).toMatchObject({
      assigneeUserId: h.users.salesB,
      version: 2,
    });
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

  it('an old owner the rule stops from handing the lead on moves nothing', async () => {
    const lead = await seed();
    const mine = await plan(lead.id, h.users.salesA);
    const res = await patch(lead.id, { ownerUserId: h.users.salesB, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await activityRow(mine.id)).toMatchObject({
      assigneeUserId: h.users.salesA,
      version: 1,
    });
  });

  it('an edit that does not change the owner moves nothing', async () => {
    const lead = await seed();
    const mine = await plan(lead.id, h.users.salesA);
    h.as('boss', 'founder');
    const res = await patch(lead.id, { title: 'Renamed', expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(await activityRow(mine.id)).toMatchObject({
      assigneeUserId: h.users.salesA,
      version: 1,
    });
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

describe('D50: who a lead may be handed to, under the entity rule and live grants', () => {
  let salesDept: string;
  let marketingDept: string;
  /** Sales department: two staff, a manager and the head. */
  let salesStaff: string;
  let salesPeer: string;
  let salesManager: string;
  let salesHead: string;
  /** Marketing department: one staff member. */
  let marketingStaff: string;
  /** Starts leads for Sales (D50 intake), no department. */
  let finance: string;
  /** Active staff whose roles read no lead. */
  let warehouse: string;

  beforeAll(async () => {
    // Named Sales and Marketing: the entity's default hand-over pair (Marketing to Sales) is found by these names.
    salesDept = await h.department('Sales');
    marketingDept = await h.department('Marketing');
    const sales = { roles: ['sales'] as const, departmentId: salesDept };
    salesHead = await h.member({ ...sales, level: 'head', displayName: 'Hari Head' });
    salesManager = await h.member({ ...sales, level: 'manager', displayName: 'Mina Manager' });
    salesPeer = await h.member({ ...sales, displayName: 'Pia Peer' });
    salesStaff = await h.member({ ...sales, displayName: 'Sam Staff' });
    marketingStaff = await h.member({
      roles: ['marketing'],
      departmentId: marketingDept,
      displayName: 'Maya Marketing',
    });
    finance = await h.member({ roles: ['finance'], displayName: 'Fina Finance' });
    warehouse = await h.member({ roles: ['warehouse'], displayName: 'Wes Warehouse' });
  });

  /** The rule's code on a refused hand-over, read from the service's 400 (`details.assignmentReason`). */
  async function refusal(run: () => Promise<unknown>): Promise<string | undefined> {
    try {
      await run();
    } catch (error) {
      if (!(error instanceof BadRequestException)) throw error;
      return (error.getResponse() as { details?: { assignmentReason?: string } }).details
        ?.assignmentReason;
    }
    throw new Error('expected a 400');
  }
  const reassign = (leadId: string, ownerUserId: string, expectedVersion = 1) =>
    refusal(() => service.update(leadId, { ownerUserId, expectedVersion }));
  const ownerIds = async (query = '') => {
    const res = await request(baseUrl).get(`/v1/leads/owners${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return LeadOwnerOptionSchema.array()
      .parse(res.body)
      .map((o) => o.userId);
  };
  const assignedNotices = async (leadId: string) => {
    const { rows } = await h.ownerPool.query(
      `SELECT to_user_id, body_text FROM app.outbox
        WHERE tenant_id = $1 AND template = 'crm.assigned' AND dedupe_key LIKE $2`,
      [h.tenantId, `crm.assigned:lead:${leadId}:%`],
    );
    return rows as { to_user_id: string; body_text: string }[];
  };

  it('Sales staff hands a lead to a same-level peer, never upward and never to Marketing', async () => {
    await h.actAs(salesStaff);
    const lead = await seed();
    expect((await rowOf(lead.id)).departmentId).toBe(salesDept);

    const upward = await patch(lead.id, { ownerUserId: salesManager, expectedVersion: 1 });
    expect(upward.status, JSON.stringify(upward.body)).toBe(400);
    expect(errorOf(upward.body).message).toBe(`ownerUserId ${ASSIGNMENT_DENY_MESSAGES.upward}`);
    expect(await reassign(lead.id, salesManager)).toBe('upward');
    expect(await reassign(lead.id, salesHead)).toBe('upward');

    const toMarketing = await patch(lead.id, { ownerUserId: marketingStaff, expectedVersion: 1 });
    expect(toMarketing.status, JSON.stringify(toMarketing.body)).toBe(400);
    expect(errorOf(toMarketing.body).message).toBe(
      `ownerUserId ${ASSIGNMENT_DENY_MESSAGES.reverse_handoff}`,
    );
    expect(await reassign(lead.id, marketingStaff)).toBe('reverse_handoff');
    expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: salesStaff, version: 1 });

    const res = await patch(lead.id, { ownerUserId: salesPeer, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(dto(res.body).ownerUserId).toBe(salesPeer);
  });

  it('Marketing staff hands a lead to Sales staff: the lead joins the Sales department, the creator keeps reading it', async () => {
    await h.actAs(marketingStaff);
    const lead = await seed();
    expect((await rowOf(lead.id)).departmentId).toBe(marketingDept);
    // The hand-over never goes up a level either.
    expect(await reassign(lead.id, salesManager)).toBe('upward');

    const res = await patch(lead.id, { ownerUserId: salesStaff, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    // D55-4: the database stamps the department from the new owner when, and only when, the owner changes.
    expect(await rowOf(lead.id)).toMatchObject({
      ownerUserId: salesStaff,
      departmentId: salesDept,
      createdByUserId: marketingStaff,
    });
    // Marketing entered it, so it still reads it (D50 `created`), but the edit is the new owner's.
    expect((await request(baseUrl).get(`/v1/leads/${lead.id}`)).status).toBe(200);
    expect((await patch(lead.id, { title: 'Still mine?', expectedVersion: 2 })).status).toBe(404);
  });

  it('Finance starts a lead for Sales: never for itself, the Sales head by default, then reads it but cannot edit it', async () => {
    await h.actAs(finance);
    const own = await request(baseUrl)
      .post('/v1/leads')
      .send({ ...BODY, ownerUserId: finance });
    expect(own.status, JSON.stringify(own.body)).toBe(400);
    expect(errorOf(own.body).message).toBe(
      `ownerUserId ${ASSIGNMENT_DENY_MESSAGES.sales_owner_required}`,
    );
    expect(
      await refusal(() =>
        service.create(CreateLeadBodySchema.parse({ ...BODY, ownerUserId: finance })),
      ),
    ).toBe('sales_owner_required');

    const lead = await seed();
    expect(lead.ownerUserId).toBe(salesHead);
    expect(await rowOf(lead.id)).toMatchObject({
      createdByUserId: finance,
      departmentId: salesDept,
    });
    // The head was told the lead is theirs; nobody else was.
    expect((await assignedNotices(lead.id)).map((n) => n.to_user_id)).toEqual([salesHead]);

    expect((await request(baseUrl).get(`/v1/leads/${lead.id}`)).status).toBe(200);
    const listed = LeadDtoSchema.array().parse((await request(baseUrl).get('/v1/leads')).body);
    expect(listed.map((l) => l.id)).toContain(lead.id);
    expect((await patch(lead.id, { title: 'Edited by Finance', expectedVersion: 1 })).status).toBe(
      404,
    );

    // The new-lead form's owner select offers Finance the Sales people with a department, not Finance itself.
    expect(new Set(await ownerIds('?context=create'))).toEqual(
      new Set([salesStaff, salesPeer, salesManager, salesHead]),
    );
    // The intake hand-off is for a new lead only: on an existing one the rule offers Finance no one but itself.
    expect(await ownerIds()).toEqual([finance]);
  });

  it("hands Finance's unowned lead to the entity's default lead owner when one is set (F1-Q21)", async () => {
    const settings = new SettingsService(h.db);
    const setDefault = (value: string | null) =>
      withTx(h.db, h.scopeA, systemActor('test'), (tx) =>
        settings.set(tx, 'crm.default_lead_owner', value),
      );
    try {
      await h.actAs(finance);
      // Unset (the default): the Sales head, as before.
      expect((await seed()).ownerUserId).toBe(salesHead);

      await setDefault(salesPeer);
      const lead = await seed();
      expect(lead.ownerUserId).toBe(salesPeer);
      expect((await assignedNotices(lead.id)).map((n) => n.to_user_id)).toEqual([salesPeer]);
      // A named owner still wins.
      const named = LeadDtoSchema.parse(
        await service.create(CreateLeadBodySchema.parse({ ...BODY, ownerUserId: salesStaff })),
      );
      expect(named.ownerUserId).toBe(salesStaff);

      // Someone the lead may not be handed to (no lead read) is skipped: back to the Sales head.
      await setDefault(warehouse);
      expect((await seed()).ownerUserId).toBe(salesHead);

      // A caller who may own the lead keeps it: the setting is only for leads nobody would own.
      await setDefault(salesPeer);
      await h.actAs(salesStaff);
      expect((await seed()).ownerUserId).toBe(salesStaff);
    } finally {
      await setDefault(null);
    }
  });

  it('offers in the owner select exactly the people PATCH accepts', async () => {
    const everyone = [
      salesStaff,
      salesPeer,
      salesManager,
      salesHead,
      marketingStaff,
      finance,
      warehouse,
      h.users.salesA,
      h.users.boss,
      h.users.viewer,
    ];
    const cases: [string, string[]][] = [
      // Same-level peers.
      [salesStaff, [salesStaff, salesPeer]],
      // Staff and managers of the department, not the head.
      [salesManager, [salesManager, salesStaff, salesPeer]],
      // Their own department at or below their level, and Sales at or below (the Marketing to Sales hand-over).
      [marketingStaff, [marketingStaff, salesStaff, salesPeer]],
    ];
    for (const [actor, expected] of cases) {
      await h.actAs(actor);
      expect(new Set(await ownerIds()), actor).toEqual(new Set(expected));
      for (const target of everyone) {
        await h.actAs(actor);
        const lead = await seed();
        const res = await patch(lead.id, { ownerUserId: target, expectedVersion: 1 });
        if (target === actor) {
          // Naming the current owner changes nothing.
          expect(res.status, `${actor} -> self`).toBe(400);
          continue;
        }
        expect(res.status, `${actor} -> ${target}: ${JSON.stringify(res.body)}`).toBe(
          expected.includes(target) ? 200 : 400,
        );
      }
    }
  });

  it('a manager edits and reassigns a staff lead of their department (department reach), not another department', async () => {
    await h.actAs(salesStaff);
    const staffLead = await seed();
    await h.actAs(marketingStaff);
    const marketingLead = await seed();

    await h.actAs(salesManager);
    // The premise: the manager level row widens the Sales lead grants to the department (the level defaults).
    const me = h.caller.current().principal;
    expect(me.grants.get('crm.lead.write')).toBe('department');
    expect(me.grants.get('crm.lead.read')).toBe('department');

    expect((await request(baseUrl).get(`/v1/leads/${staffLead.id}`)).status).toBe(200);
    const edited = await patch(staffLead.id, {
      title: 'Checked by the manager',
      expectedVersion: 1,
    });
    expect(edited.status, JSON.stringify(edited.body)).toBe(200);
    const moved = await patch(staffLead.id, { ownerUserId: salesPeer, expectedVersion: 2 });
    expect(moved.status, JSON.stringify(moved.body)).toBe(200);
    expect(dto(moved.body).ownerUserId).toBe(salesPeer);

    expect((await request(baseUrl).get(`/v1/leads/${marketingLead.id}`)).status).toBe(404);
    expect((await patch(marketingLead.id, { title: 'Not mine', expectedVersion: 1 })).status).toBe(
      404,
    );
  });

  it('the assignee of a follow-up reads the lead, read only, for as long as the follow-up is open', async () => {
    await h.actAs(salesStaff);
    const lead = await seed();
    const followUp = await plan(lead.id, salesPeer);

    await h.actAs(salesPeer);
    expect((await request(baseUrl).get(`/v1/leads/${lead.id}`)).status).toBe(200);
    const listed = LeadDtoSchema.array().parse((await request(baseUrl).get('/v1/leads')).body);
    expect(listed.map((l) => l.id)).toContain(lead.id);
    expect((await patch(lead.id, { title: 'Assignee edit', expectedVersion: 1 })).status).toBe(404);

    await withTx(h.db, h.scopeA, sys(), (tx) =>
      tx.update(activities).set({ cancelledAt: new Date() }).where(eq(activities.id, followUp.id)),
    );
    expect((await request(baseUrl).get(`/v1/leads/${lead.id}`)).status).toBe(404);
  });

  it('tells the new owner once per change (crm.assigned), and nobody when the owner is the caller', async () => {
    await h.actAs(salesStaff);
    const lead = await seed();
    expect(await assignedNotices(lead.id)).toEqual([]);

    expect((await patch(lead.id, { ownerUserId: salesPeer, expectedVersion: 1 })).status).toBe(200);
    const first = await assignedNotices(lead.id);
    expect(first.map((n) => n.to_user_id)).toEqual([salesPeer]);
    // The email links the lead's own page; the workspace has no /crm route.
    expect(first[0]!.body_text).toContain(`${WORKSPACE_URL}/leads/${lead.id}`);
    expect(first[0]!.body_text).toContain('Sam Staff');
    const { rows: bell } = await h.ownerPool.query(
      `SELECT user_id, link FROM app.notifications WHERE tenant_id = $1 AND dedupe_key LIKE $2`,
      [h.tenantId, `crm.assigned:lead:${lead.id}:%`],
    );
    expect(bell).toEqual([{ user_id: salesPeer, link: `/leads/${lead.id}` }]);

    // Handed back: one more notice, to the new owner only.
    await h.actAs(salesPeer);
    expect((await patch(lead.id, { ownerUserId: salesStaff, expectedVersion: 2 })).status).toBe(
      200,
    );
    expect((await assignedNotices(lead.id)).map((n) => n.to_user_id).sort()).toEqual(
      [salesPeer, salesStaff].sort(),
    );

    // Taking a lead yourself, or creating one you own, tells nobody.
    h.as('boss', 'founder');
    expect((await patch(lead.id, { ownerUserId: h.users.boss, expectedVersion: 3 })).status).toBe(
      200,
    );
    const own = await seed();
    expect(await assignedNotices(lead.id)).toHaveLength(2);
    expect(await assignedNotices(own.id)).toEqual([]);
  });

  it('tells the assignee of the first follow-up at create (U20a2-Q8), but not the creator or the told owner', async () => {
    const followUpNotices = async (leadId: string) => {
      const { rows } = await h.ownerPool.query(
        `SELECT o.to_user_id,
                (SELECT n.link FROM app.notifications n
                  WHERE n.tenant_id = o.tenant_id AND n.dedupe_key LIKE 'crm.assigned:activity:' || a.id || ':%') AS link
           FROM app.outbox o
           JOIN app.activities a ON o.dedupe_key LIKE 'crm.assigned:activity:' || a.id || ':%'
          WHERE o.tenant_id = $1 AND o.template = 'crm.assigned' AND a.lead_id = $2`,
        [h.tenantId, leadId],
      );
      return rows as { to_user_id: string; link: string }[];
    };
    const followUp = (assigneeUserId?: string) => ({
      kind: 'call' as const,
      dueAt: '2030-01-01T09:00:00.000Z',
      subject: 'Call the buyer',
      ...(assigneeUserId === undefined ? {} : { assigneeUserId }),
    });

    await h.actAs(salesStaff);
    const handed = LeadDtoSchema.parse(
      await service.create(
        CreateLeadBodySchema.parse({ ...BODY, title: 'Q8 handed', followUp: followUp(salesPeer) }),
      ),
    );
    expect(await followUpNotices(handed.id)).toEqual([
      { to_user_id: salesPeer, link: `/leads/${handed.id}` },
    ]);
    expect(await assignedNotices(handed.id)).toEqual([]);

    // Assigned to themselves, or left to the owner: no follow-up notice.
    const mine = LeadDtoSchema.parse(
      await service.create(
        CreateLeadBodySchema.parse({ ...BODY, title: 'Q8 mine', followUp: followUp(salesStaff) }),
      ),
    );
    const byDefault = LeadDtoSchema.parse(
      await service.create(
        CreateLeadBodySchema.parse({ ...BODY, title: 'Q8 default', followUp: followUp() }),
      ),
    );
    expect(await followUpNotices(mine.id)).toEqual([]);
    expect(await followUpNotices(byDefault.id)).toEqual([]);

    // Started for another owner who also takes the follow-up: the owner's lead notice is the only one.
    const forPeer = LeadDtoSchema.parse(
      await service.create(
        CreateLeadBodySchema.parse({
          ...BODY,
          title: 'Q8 for peer',
          ownerUserId: salesPeer,
          followUp: followUp(salesPeer),
        }),
      ),
    );
    expect((await assignedNotices(forPeer.id)).map((n) => n.to_user_id)).toEqual([salesPeer]);
    expect(await followUpNotices(forPeer.id)).toEqual([]);
  });

  it('refuses an owner who cannot read leads (cannot_read_subject), and never offers them', async () => {
    h.as('boss', 'founder');
    const lead = await seed();
    const res = await patch(lead.id, { ownerUserId: warehouse, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(errorOf(res.body).message).toBe(
      `ownerUserId ${ASSIGNMENT_DENY_MESSAGES.cannot_read_subject}`,
    );
    expect(await reassign(lead.id, warehouse)).toBe('cannot_read_subject');
    expect(await ownerIds()).not.toContain(warehouse);
    expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: h.users.boss, version: 1 });
  });

  it('never makes Management a lead owner: it reads every lead and writes none, until its live grants write leads', async () => {
    h.as('boss', 'founder');
    const lead = await seed();
    const res = await patch(lead.id, { ownerUserId: h.users.viewer, expectedVersion: 1 });
    expect(res.status, JSON.stringify(res.body)).toBe(400);
    expect(await reassign(lead.id, h.users.viewer)).toBe('cannot_read_subject');
    expect(await ownerIds()).not.toContain(h.users.viewer);
    expect(await ownerIds('?context=create')).not.toContain(h.users.viewer);
    expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: h.users.boss, version: 1 });

    // The check reads live grants, not role names: once Management's grants write leads, it may own one.
    const live = h.roleCache.grantsFor.bind(h.roleCache);
    const spy = vi
      .spyOn(h.roleCache, 'grantsFor')
      .mockImplementation(async (tenantId, organizationId, roles, level) => {
        const grants = await live(tenantId, organizationId, roles, level);
        if (!roles.includes('management')) return grants;
        const widened = new Map(grants);
        widened.set('crm.lead.write', 'all');
        return widened;
      });
    try {
      expect(await ownerIds()).toContain(h.users.viewer);
      const moved = await patch(lead.id, { ownerUserId: h.users.viewer, expectedVersion: 1 });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      expect(await rowOf(lead.id)).toMatchObject({ ownerUserId: h.users.viewer, version: 2 });
    } finally {
      spy.mockRestore();
    }
  });

  it('never makes the caller the owner of a new lead their read would not show them, named or by default', async () => {
    await h.actAs(salesStaff);
    const me = h.caller.current();
    // A stored lead read of `assigned` reaches only records with a follow-up for the caller, never what they own.
    const grants = new Map(me.principal.grants);
    grants.set('crm.lead.read', 'assigned');
    const narrowed = { ...me, principal: { ...me.principal, grants } };
    const spy = vi.spyOn(h.caller, 'current').mockReturnValue(narrowed);
    const title = 'Out of my own reach';
    try {
      expect(
        await refusal(() => service.create(CreateLeadBodySchema.parse({ ...BODY, title }))),
      ).toBe('cannot_read_subject');
      expect(
        await refusal(() =>
          service.create(CreateLeadBodySchema.parse({ ...BODY, title, ownerUserId: salesStaff })),
        ),
      ).toBe('cannot_read_subject');
    } finally {
      spy.mockRestore();
    }
    const made = await h.db
      .select({ id: leads.id })
      .from(leads)
      .where(and(eq(leads.createdByUserId, salesStaff), eq(leads.title, title)));
    expect(made).toEqual([]);
  });

  it('the Owner filter lists the owners of the leads the caller reads, plus whom they may hand a lead to', async () => {
    const filter = async () => {
      const res = await request(baseUrl).get('/v1/leads/owner-filter');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return LeadOwnerOptionSchema.array().parse(res.body);
    };
    await h.actAs(salesStaff);
    await seed();

    // Management reads every lead of the entity and hands none on (no lead write).
    h.as('viewer', 'management');
    const rows = await h.db
      .selectDistinct({ ownerUserId: leads.ownerUserId })
      .from(leads)
      .where(
        and(
          eq(leads.tenantId, h.tenantId),
          eq(leads.organizationId, h.scopeA.organizationId),
          isNotNull(leads.ownerUserId),
        ),
      );
    const everyOwner = rows.map((r) => r.ownerUserId);
    const forManagement = await filter();
    expect(new Set(forManagement.map((o) => o.userId))).toEqual(new Set(everyOwner));
    // Names only: the filter needs no address, and an unnamed person reads as such.
    expect(forManagement.every((o) => o.email === '' && o.displayName.length > 0)).toBe(true);
    expect(forManagement.find((o) => o.userId === salesStaff)?.displayName).toBe('Sam Staff');

    // A salesperson: the owners of what they read (their own leads, the ones they entered or follow up) and their
    // peers, never the owners of leads beyond their reach.
    await h.actAs(salesStaff);
    const visible = LeadDtoSchema.array()
      .parse((await request(baseUrl).get('/v1/leads?limit=200')).body)
      .map((l) => l.ownerUserId)
      .filter((id): id is string => id !== null);
    expect(new Set((await filter()).map((o) => o.userId))).toEqual(
      new Set([...visible, salesStaff, salesPeer]),
    );
    expect((await filter()).map((o) => o.userId)).not.toContain(h.users.salesB);
  });
});
