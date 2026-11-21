// Integration tests of DraftingService create, list, detail, getVersion and updateDraft on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every DB CHECK and trigger of 0016 runs), NumberingService,
// PricingService (NPR only: the MoneyService behind it is a stub that fails if FX is ever asked for) and the real
// AuditService. Faked: the request context, and authz.assert, which still runs the real pure can() on a fake
// principal, so the ResourceRef the service builds is what decides. The controller is another unit's, so the
// service is called directly; its exceptions carry the HTTP status.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/drafting.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import {
  type AccessScope,
  DEFAULT_ROLE_PERMISSIONS,
  type ListQuotationsQuery,
  QuotationDetailSchema,
  QuotationDtoSchema,
  QuotationListItemSchema,
  QuotationSummarySchema,
  QuotationVersionDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import Decimal from 'decimal.js';
import {
  activities,
  createDepartment,
  createParty,
  leads,
  opportunities,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  rolePermissions,
  verificationCases,
} from '@bos/db';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService, scopeWhereFor } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { RoleCache } from '../../../platform/authz/role-cache';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { PricingService } from '../pricing/pricing.service';
import { toOpportunityDto } from '../../opportunities/opportunities.types';
import { DraftingService, pricingInputOf } from './drafting.service';
import {
  GOLDEN_DISCOUNT,
  GOLDEN_INTERNAL_COST,
  GOLDEN_TOTALS,
  GOLDEN_UNIT_COSTS,
  goldenCostedLines,
  goldenCreateBody,
  goldenLines,
  seedOtherStaffUser,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: QuotationFixtureDb;
let f: QuotationFixture;
let scopeA: TxScope;
let pricing: PricingService;
let service: DraftingService;

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
/** Who calls: by default the fixture's owner in entity A with the sales grants; a test may switch any part. */
const current: {
  grants: Map<Permission, Scope>;
  userId: string | null;
  scope: TxScope | null;
  /** The caller's membership department; null (no department) unless a test sets one. */
  departmentId?: string | null;
  /** The caller's role keys; none unless a test sets them. */
  roles?: RoleKey[];
} = {
  grants: grantsOf('sales'),
  userId: null,
  scope: null,
};
const userNow = (): string => current.userId ?? f.ownerUserId;
const scopeNow = (): TxScope => current.scope ?? scopeA;

const principalNow = (): Principal => ({
  userId: userNow(),
  zitadelUserId: `z-${userNow()}`,
  ...scopeNow(),
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: current.roles ?? [],
  departmentId: current.departmentId ?? null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: scopeNow(),
    actor: { kind: 'user' as const, id: userNow(), correlationId: 'test-corr' },
    principal: principalNow(),
  }),
};
const authz = {
  assert: (action: Permission, ref?: Parameters<typeof can>[2]) => {
    const d = can(principalNow(), action, ref);
    if (!d.allowed) {
      throw new ForbiddenException({ code: 'forbidden', message: 'Forbidden', reason: d.reason });
    }
  },
};
/** NPR needs no rate; a call here means pricing took the FX path by mistake. */
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  f = await seedQuotationFixture(db);
  scopeA = { tenantId: f.tenantId, organizationId: f.entityId };
  pricing = new PricingService(money);
  service = new DraftingService(
    db,
    new NumberingService(),
    pricing,
    authz as unknown as AuthzService,
    new AuditService(db),
    caller,
    new CurrencyEnabledService(new SettingsService(db)),
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  current.grants = grantsOf('sales');
  current.userId = null;
  current.scope = null;
  current.departmentId = null;
  delete current.roles;
});

// ---------------------------------------------------------------------------------------- helpers

/** The HTTP status `promise` rejects with; fails the test when it resolves. */
async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof HttpException) return error.getStatus();
    throw error;
  }
  throw new Error('expected the call to fail');
}

/** A second customer of the tenant with one contact, for the contact-of-another-customer case. */
async function seedOtherCustomerContact(): Promise<string> {
  const { partyId } = await createParty(appPool, { tenantId: f.tenantId, kind: 'customer' });
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
          VALUES (${partyId}, ${f.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, 'Other Ltd.', 'other',
                  ${JSON.stringify({ line1: '2 New Road', city: 'Kathmandu', country: 'NP' })}::jsonb)`,
    );
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name, email_norm)
          VALUES (${f.tenantId}, ${partyId}, 'Other Contact', 'other@example.test')
          RETURNING id`,
    );
    return rows[0]!.id;
  });
}

const quotationCount = async (opportunityId: string): Promise<number> => {
  const rows = await db
    .select({ id: quotations.id })
    .from(quotations)
    .where(eq(quotations.opportunityId, opportunityId));
  return rows.length;
};

// ------------------------------------------------------------------------------------------ create

describe('DraftingService.create', () => {
  it('stores a QT-numbered quotation with a Draft revision 1 priced exactly as priceVersion prices it', async () => {
    const body = goldenCreateBody(f);
    const dto = QuotationDtoSchema.parse(await service.create(body, 'create-golden'));

    expect(dto.number).toMatch(/^QT-/);
    expect(dto).toMatchObject({
      customerId: f.customerPartyId,
      opportunityId: f.opportunityId,
      ownerUserId: f.ownerUserId,
      status: 'draft',
    });

    const expected = await withTx(db, scopeA, systemActor('test'), (tx) =>
      pricing.priceVersion(tx, scopeA, pricingInputOf(body)),
    );
    expect(expected.columns).toMatchObject(GOLDEN_TOTALS);

    const [parent] = await db.select().from(quotations).where(eq(quotations.id, dto.id));
    expect(parent!.currentVersionId).toBe(dto.currentVersionId);
    expect(parent!.organizationId).toBe(f.entityId);

    const [version] = await db
      .select()
      .from(quotationVersions)
      .where(eq(quotationVersions.id, dto.currentVersionId));
    expect(version).toMatchObject({
      quotationId: dto.id,
      revisionNo: 1,
      status: 'draft',
      currency: 'NPR',
      discountMode: 'pct',
      ...expected.columns,
    });
    expect(Number(version!.discountInput)).toBe(8);

    const lines = await db
      .select()
      .from(quotationLines)
      .where(eq(quotationLines.versionId, dto.currentVersionId))
      .orderBy(asc(quotationLines.lineNo));
    expect(lines).toHaveLength(3);
    lines.forEach((line, i) => expect(line).toMatchObject(expected.lines[i]!));

    const summary = await db
      .select()
      .from(quotationTaxSummary)
      .where(eq(quotationTaxSummary.versionId, dto.currentVersionId));
    expect(summary).toHaveLength(expected.taxSummary.length);
    for (const row of expected.taxSummary) {
      expect(summary.find((s) => s.taxCodeId === row.taxCodeId)).toMatchObject(row);
    }

    const history = await db
      .select()
      .from(quotationStatusHistory)
      .where(eq(quotationStatusHistory.versionId, dto.currentVersionId));
    expect(history).toEqual([
      expect.objectContaining({ fromStatus: null, toStatus: 'draft', actorId: f.ownerUserId }),
    ]);

    const { rows: audit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, dto.id],
    );
    expect(audit.map((r) => r.action)).toContain('quotation.created');
  });

  it('answers 404 for an opportunity of another entity, and writes nothing', async () => {
    const body = goldenCreateBody(f, { opportunityId: f.otherEntityOpportunityId });
    await expect(service.create(body, 'create-other-entity')).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await quotationCount(f.otherEntityOpportunityId)).toBe(0);
  });

  it("answers 404 to an own-reach Sales user on another owner's opportunity, and lets them quote on their own", async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const before = await quotationCount(f.opportunityId);
    // sales holds crm.opportunity.read as `own`; the fixture opportunity is f.ownerUserId's.
    await asCaller({ userId: otherUserId }, async () => {
      await expect(
        service.create(goldenCreateBody(f), 'create-unreadable-opportunity'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(await quotationCount(f.opportunityId)).toBe(before);

    const [theirOpportunity] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Their own deal',
          customerId: f.customerPartyId,
          ownerUserId: otherUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    const mine = await asCaller({ userId: otherUserId }, () =>
      service.create(
        goldenCreateBody(f, { opportunityId: theirOpportunity!.id }),
        'create-own-opportunity',
      ),
    );
    expect(mine).toMatchObject({ opportunityId: theirOpportunity!.id, ownerUserId: otherUserId });
  });

  it('refuses a quotation to a colleague who only holds a follow-up on the opportunity (FX-Q2), 404 and nothing written', async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const [deal] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Followed-up deal',
          customerId: f.customerPartyId,
          ownerUserId: f.ownerUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.insert(activities).values({
        ...scopeA,
        kind: 'call',
        subject: 'Call the buyer',
        opportunityId: deal!.id,
        dueAt: new Date(Date.now() + 86_400_000),
        assigneeUserId: otherUserId,
        createdByUserId: f.ownerUserId,
      }),
    );
    // The follow-up still lets them read the deal (D55-5) ...
    const readable = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .select({ id: opportunities.id })
        .from(opportunities)
        .where(
          and(
            eq(opportunities.id, deal!.id),
            scopeWhereFor(
              { ...principalNow(), userId: otherUserId },
              opportunities,
              'crm.opportunity.read',
            ),
          ),
        ),
    );
    expect(readable).toHaveLength(1);
    // ... but not quote on it: sending the quotation would move someone else's deal.
    await asCaller({ userId: otherUserId }, async () => {
      await expect(
        service.create(
          goldenCreateBody(f, { opportunityId: deal!.id }),
          'create-assignee-only-opportunity',
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
    expect(await quotationCount(deal!.id)).toBe(0);
  });

  it('lets the creator of the lead an opportunity came from quote on it (FX-Q1)', async () => {
    const creatorUserId = await seedOtherStaffUser(db, f);
    const [deal] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Deal from a PMO lead',
          customerId: f.customerPartyId,
          ownerUserId: f.ownerUserId,
          leadCreatorUserId: creatorUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    // PMO's default grants: crm.opportunity.read and quotation.draft at `own`.
    const created = await asCaller({ userId: creatorUserId, grants: grantsOf('pmo') }, () =>
      service.create(goldenCreateBody(f, { opportunityId: deal!.id }), 'create-lead-creator'),
    );
    expect(created).toMatchObject({ opportunityId: deal!.id, ownerUserId: creatorUserId });
    // Without the lead creator recorded, the same caller cannot.
    const [other] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Deal from someone else',
          customerId: f.customerPartyId,
          ownerUserId: f.ownerUserId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    await asCaller({ userId: creatorUserId, grants: grantsOf('pmo') }, async () => {
      await expect(
        service.create(goldenCreateBody(f, { opportunityId: other!.id }), 'create-not-creator'),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it("refuses a caller who reads every opportunity but has no tie to another owner's deal (R4a Q4 a), 404 and nothing written", async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const missing = await asCaller({ userId: otherUserId }, () =>
      service.create(goldenCreateBody(f, { opportunityId: randomUUID() }), 'create-missing-deal'),
    ).catch((error: unknown) => error);
    expect(missing).toBeInstanceOf(NotFoundException);
    const before = await quotationCount(f.opportunityId);
    for (const [label, grants] of [
      ['accountant', grantsOf('accountant')],
      ['finance', grantsOf('finance')],
      ['management', grantsOf('management')],
      ['read-all', readsEveryOpportunity()],
    ] as const) {
      await asCaller({ userId: otherUserId, grants, roles: [label as RoleKey] }, async () => {
        expect(await draftFlagOn(f.opportunityId), label).toBe(false);
        const refused = await service
          .create(goldenCreateBody(f), `create-reads-all-${label}`)
          .catch((error: unknown) => error);
        // The same answer as a deal that does not exist: no hint that this one does.
        expect(refused, label).toBeInstanceOf(NotFoundException);
        expect((refused as NotFoundException).getResponse(), label).toEqual(
          (missing as NotFoundException).getResponse(),
        );
      });
    }
    expect(await quotationCount(f.opportunityId)).toBe(before);
  });

  it('lets the Founder draft on any deal with no owner, department or lead-creator tie (P5-Q2), flag true', async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const before = await quotationCount(f.opportunityId);
    await asCaller(
      { userId: otherUserId, grants: grantsOf('founder'), roles: ['founder'] },
      async () => {
        expect(await draftFlagOn(f.opportunityId)).toBe(true);
        const created = await service.create(goldenCreateBody(f), 'create-founder-no-tie');
        expect(created.ownerUserId).toBe(otherUserId);
      },
    );
    expect(await quotationCount(f.opportunityId)).toBe(before + 1);
  });

  it('does not exempt a Founder grant set without the founder role key', async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    await asCaller({ userId: otherUserId, grants: grantsOf('founder'), roles: [] }, async () => {
      expect(await draftFlagOn(f.opportunityId)).toBe(false);
    });
  });

  it("answers 400 for a contact of another customer than the opportunity's", async () => {
    const contactId = await seedOtherCustomerContact();
    const before = await quotationCount(f.opportunityId);
    const error = service.create(goldenCreateBody(f, { contactId }), 'create-mismatch');
    await expect(error).rejects.toBeInstanceOf(BadRequestException);
    expect(await quotationCount(f.opportunityId)).toBe(before);
  });

  it('returns the same quotation for a replay of the same Idempotency-Key and body', async () => {
    const body = goldenCreateBody(f);
    const before = await quotationCount(f.opportunityId);
    const first = await service.create(body, 'create-replay');
    const second = await service.create(body, 'create-replay');
    expect(second.id).toBe(first.id);
    expect(second.number).toBe(first.number);
    expect(await quotationCount(f.opportunityId)).toBe(before + 1);
  });

  it('refuses a caller without quotation.draft before reading anything', async () => {
    current.grants = new Map();
    const before = await quotationCount(f.opportunityId);
    expect(await statusOf(service.create(goldenCreateBody(f), 'create-denied'))).toBe(403);
    expect(await quotationCount(f.opportunityId)).toBe(before);
  });
});

// ------------------------------------------------------------------------------------------- reads

/** A contact of the fixture's customer, so the detail has a recipient to offer. */
async function seedCustomerContact(name: string): Promise<string> {
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.customer_contacts (tenant_id, customer_id, full_name, email_norm)
          VALUES (${f.tenantId}, ${f.customerPartyId}, ${name}, ${`${randomUUID()}@example.test`})
          RETURNING id`,
    );
    return rows[0]!.id;
  });
}

/** Runs `fn` as another caller, then switches back to the default one. */
async function asCaller<T>(
  who: {
    userId?: string;
    scope?: TxScope;
    grants?: Map<Permission, Scope>;
    departmentId?: string | null;
    roles?: RoleKey[];
  },
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { ...current };
  current.userId = who.userId ?? current.userId;
  current.scope = who.scope ?? current.scope;
  current.grants = who.grants ?? current.grants;
  current.departmentId =
    who.departmentId === undefined ? (current.departmentId ?? null) : who.departmentId;
  if (who.roles !== undefined) current.roles = who.roles;
  try {
    return await fn();
  } finally {
    delete current.roles;
    Object.assign(current, saved);
  }
}

/**
 * Sales grants plus every opportunity of the entity: a colleague who may quote on the fixture owner's opportunity,
 * which `own` reach on `crm.opportunity.read` refuses.
 */
const readsEveryOpportunity = (): Map<Permission, Scope> =>
  new Map([...grantsOf('sales'), ['crm.opportunity.read', 'all']]);

/**
 * Runs `fn` as `userId`, recorded as the creator of the lead `opportunityId` came from: a tie that lets a colleague
 * with Sales grants quote on another owner's deal (R4a Q4 a), for tests about who then sees that quotation.
 */
async function asLeadCreator<T>(
  userId: string,
  opportunityId: string,
  fn: () => Promise<T>,
): Promise<T> {
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .update(opportunities)
      .set({ leadCreatorUserId: userId })
      .where(eq(opportunities.id, opportunityId)),
  );
  return asCaller({ userId }, fn);
}

/** The rows of one page of `service.list`; the limit is raised so earlier tests' rows never push a row off it. */
const listRows = async (q: Partial<ListQuotationsQuery> = {}) =>
  (await service.list({ limit: 100, ...q })).rows;

/** 32 bytes for a bytea hash column, as hex for decode(). */
const HASH_HEX = 'ab'.repeat(32);

/**
 * Revises `quotationId` by raw SQL in S2's order (old to superseded, insert the new draft, link the old to it),
 * then points the parent at the new version. The old version needs the snapshot columns that
 * quotation_versions_snapshot_check requires outside draft, returned and cancelled. Returns the new version id.
 */
async function reviseBySql(quotationId: string, oldVersionId: string): Promise<string> {
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET status = 'superseded', fx_rate = 1, amount_npr = total, npr_taxable_amount = taxable_amount,
                 content_sha256 = decode(${HASH_HEX}, 'hex'), snapshot_sha256 = decode(${HASH_HEX}, 'hex')
           WHERE tenant_id = ${f.tenantId} AND id = ${oldVersionId}`,
    );
    const { rows } = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotation_versions
            (tenant_id, organization_id, quotation_id, revision_no, status, currency, issue_date, valid_until,
             supersedes_version_id, revision_reason)
          SELECT tenant_id, organization_id, quotation_id, revision_no + 1, 'draft', currency, issue_date,
                 valid_until, id, 'Customer asked for a new scope'
            FROM app.quotation_versions
           WHERE tenant_id = ${f.tenantId} AND id = ${oldVersionId}
          RETURNING id`,
    );
    const newVersionId = rows[0]!.id;
    await tx.execute(
      sql`UPDATE app.quotation_versions SET superseded_by_version_id = ${newVersionId}
           WHERE tenant_id = ${f.tenantId} AND id = ${oldVersionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotations SET current_version_id = ${newVersionId}
           WHERE tenant_id = ${f.tenantId} AND id = ${quotationId}`,
    );
    return newVersionId;
  });
}

/** The deal's `canDraftQuotation` as the opportunities API maps it for the current caller. */
async function draftFlagOn(opportunityId: string): Promise<boolean | undefined> {
  const [row] = await db.select().from(opportunities).where(eq(opportunities.id, opportunityId));
  return toOpportunityDto(row!, null, null, principalNow()).canDraftQuotation;
}

// ------------------------------------------------------------------------------- who may start one

describe('who may start a quotation on a deal (R4a Q4 a)', () => {
  /**
   * A deal owned by a colleague filed in a new department, so the deal is stamped with it (0080), and created from a
   * lead another user wrote. The fixture owner stays out of both.
   */
  async function departmentDeal(): Promise<{
    id: string;
    ownerId: string;
    departmentId: string;
    leadCreatorId: string;
  }> {
    const ownerId = await seedOtherStaffUser(db, f);
    const leadCreatorId = await seedOtherStaffUser(db, f);
    const { departmentId } = await createDepartment(appPool, scopeA);
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.user_entities SET department_id = ${departmentId}
            WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
              AND user_id = ${ownerId}`,
      ),
    );
    const [deal] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Department deal',
          customerId: f.customerPartyId,
          ownerUserId: ownerId,
          leadCreatorUserId: leadCreatorId,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id, departmentId: opportunities.departmentId }),
    );
    expect(deal!.departmentId).toBe(departmentId);
    return { id: deal!.id, ownerId, departmentId, leadCreatorId };
  }

  /** Starts a quotation as the current caller, then finds it again as that same caller. */
  async function startAndFollow(opportunityId: string, label: string): Promise<void> {
    expect(await draftFlagOn(opportunityId), label).toBe(true);
    const created = await service.create(
      goldenCreateBody(f, { opportunityId }),
      `start-${label}-${randomUUID()}`,
    );
    expect(created, label).toMatchObject({ opportunityId, ownerUserId: userNow() });
    expect((await service.detail(created.id)).quotation.id, label).toBe(created.id);
    expect(
      (await listRows({ opportunityId })).map((q) => q.id),
      label,
    ).toContain(created.id);
  }

  it('lets the owner start one and find it again', async () => {
    const deal = await departmentDeal();
    await asCaller({ userId: deal.ownerId, departmentId: deal.departmentId }, () =>
      startAndFollow(deal.id, 'owner'),
    );
  });

  it("lets someone in the owner's department start one, even an Accountant, and find it again", async () => {
    const deal = await departmentDeal();
    const colleague = await seedOtherStaffUser(db, f);
    const salesDepartmentRead: Map<Permission, Scope> = new Map([
      ...grantsOf('sales'),
      ['crm.opportunity.read', 'department'],
    ]);
    for (const [label, grants] of [
      ['sales-department-read', salesDepartmentRead],
      ['accountant', grantsOf('accountant')],
    ] as const) {
      await asCaller({ userId: colleague, grants, departmentId: deal.departmentId }, () =>
        startAndFollow(deal.id, label),
      );
    }
  });

  it('refuses a same-department colleague who cannot read the deal at all (own reach), 404', async () => {
    const deal = await departmentDeal();
    const colleague = await seedOtherStaffUser(db, f);
    const before = await quotationCount(deal.id);
    await asCaller({ userId: colleague, departmentId: deal.departmentId }, async () => {
      expect(await draftFlagOn(deal.id)).toBe(false);
      expect(
        await statusOf(
          service.create(goldenCreateBody(f, { opportunityId: deal.id }), 'start-own-reach'),
        ),
      ).toBe(404);
    });
    expect(await quotationCount(deal.id)).toBe(before);
  });

  it('lets the lead creator start one with Accountant grants, and find it again', async () => {
    const deal = await departmentDeal();
    await asCaller({ userId: deal.leadCreatorId, grants: grantsOf('accountant') }, () =>
      startAndFollow(deal.id, 'lead-creator'),
    );
  });

  it('refuses an Accountant with no tie to the deal (no department, or another one): flag false, 404', async () => {
    const deal = await departmentDeal();
    const accountant = await seedOtherStaffUser(db, f);
    const otherDepartment = (await createDepartment(appPool, scopeA)).departmentId;
    const before = await quotationCount(deal.id);
    for (const departmentId of [null, otherDepartment]) {
      await asCaller(
        { userId: accountant, grants: grantsOf('accountant'), departmentId },
        async () => {
          // The Accountant still reads the deal (U20a2-Q4); only starting a quotation is refused.
          expect(await draftFlagOn(deal.id)).toBe(false);
          expect(
            await statusOf(
              service.create(
                goldenCreateBody(f, { opportunityId: deal.id }),
                `start-accountant-${String(departmentId)}`,
              ),
            ),
          ).toBe(404);
        },
      );
    }
    expect(await quotationCount(deal.id)).toBe(before);
  });

  it("answers 404 for another tenant's deal whatever the grants, and writes nothing there", async () => {
    const other = await seedQuotationFixture(db);
    const scopeOther: TxScope = { tenantId: other.tenantId, organizationId: other.entityId };
    const countThere = () =>
      withTx(db, scopeOther, systemActor('test'), async (tx) => {
        const rows = await tx
          .select({ id: quotations.id })
          .from(quotations)
          .where(eq(quotations.opportunityId, other.opportunityId));
        return rows.length;
      });
    const before = await countThere();
    for (const role of ['sales', 'founder', 'accountant'] as const) {
      await asCaller({ grants: grantsOf(role) }, async () => {
        expect(
          await statusOf(
            service.create(
              goldenCreateBody(f, { opportunityId: other.opportunityId }),
              `start-other-tenant-${role}`,
            ),
          ),
          role,
        ).toBe(404);
      });
    }
    expect(await countThere()).toBe(before);
  });
});

describe('DraftingService reads', () => {
  it('lists, details and returns one version in the contract shapes', async () => {
    const contactId = await seedCustomerContact('Asha Shrestha');
    const created = await service.create(goldenCreateBody(f), 'read-shapes');

    const list = QuotationListItemSchema.array().parse(await listRows());
    const item = list.find((q) => q.id === created.id);
    expect(item).toMatchObject({
      number: created.number,
      status: 'draft',
      customerName: 'Acme Pvt. Ltd.',
      currency: 'NPR',
      total: GOLDEN_TOTALS.total,
      validUntil: '2026-12-09',
      ownerUserId: f.ownerUserId,
    });
    expect(typeof item!.ownerName).toBe('string');
    expect(item!.ownerAvatarDocumentId).toBeNull();
    expect((await listRows({ status: ['draft'] })).map((q) => q.id)).toContain(created.id);
    expect((await listRows({ status: ['submitted'] })).map((q) => q.id)).not.toContain(created.id);

    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(detail.quotation).toMatchObject({ id: created.id, status: 'draft' });
    expect(detail.customerName).toBe('Acme Pvt. Ltd.');
    expect(detail.contacts).toContainEqual(
      expect.objectContaining({ id: contactId, name: 'Asha Shrestha' }),
    );
    expect(detail.versions).toHaveLength(1);
    const [v1] = detail.versions;
    expect(v1).toMatchObject({
      id: created.currentVersionId,
      revisionNo: 1,
      status: 'draft',
      renderedScanStatus: null,
    });
    expect(v1!.totals.total).toBe(GOLDEN_TOTALS.total);
    expect(v1!.lines.map((l) => l.lineNo)).toEqual([1, 2, 3]);
    expect(v1!.taxSummary.length).toBeGreaterThan(0);
    expect(detail.statusHistory).toEqual([
      expect.objectContaining({ versionId: v1!.id, fromStatus: null, toStatus: 'draft' }),
    ]);

    const version = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expect(version).toEqual(v1);
  });

  it('includes a superseded version in the detail, oldest first', async () => {
    const created = await service.create(goldenCreateBody(f), 'read-superseded');
    const v2Id = await reviseBySql(created.id, created.currentVersionId);

    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(detail.quotation).toMatchObject({ currentVersionId: v2Id, status: 'draft' });
    expect(detail.versions.map((v) => [v.revisionNo, v.status])).toEqual([
      [1, 'superseded'],
      [2, 'draft'],
    ]);
    expect(detail.versions[0]).toMatchObject({
      supersededByVersionId: v2Id,
      snapshotSha256: HASH_HEX,
    });
    expect(detail.versions[1]).toMatchObject({ supersedesVersionId: created.currentVersionId });
    expect((await service.getVersion(created.id, created.currentVersionId)).status).toBe(
      'superseded',
    );
  });

  it("answers 404 for another entity's quotation and leaves it out of the list", async () => {
    const scopeB: TxScope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    const other = await asCaller({ scope: scopeB }, () =>
      service.create(
        goldenCreateBody(f, { opportunityId: f.otherEntityOpportunityId }),
        'read-other-entity',
      ),
    );
    expect(await statusOf(service.detail(other.id))).toBe(404);
    expect(await statusOf(service.getVersion(other.id, other.currentVersionId))).toBe(404);
    expect((await listRows()).map((q) => q.id)).not.toContain(other.id);
    // Even a read-all role of entity A cannot reach it.
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect(await statusOf(service.detail(other.id))).toBe(404);
    });
  });

  it('answers 404 for a version of another quotation', async () => {
    const a = await service.create(goldenCreateBody(f), 'read-mix-a');
    const b = await service.create(goldenCreateBody(f), 'read-mix-b');
    expect(await statusOf(service.getVersion(a.id, b.currentVersionId))).toBe(404);
  });

  it("hides another owner's quotation under own scope, and shows it under all", async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const theirs = await asLeadCreator(otherUserId, f.opportunityId, () =>
      service.create(goldenCreateBody(f), 'read-other-owner'),
    );
    expect(theirs.ownerUserId).toBe(otherUserId);

    // sales holds quotation.read as `own`.
    expect((await listRows()).map((q) => q.id)).not.toContain(theirs.id);
    expect(await statusOf(service.detail(theirs.id))).toBe(404);
    expect(await statusOf(service.getVersion(theirs.id, theirs.currentVersionId))).toBe(404);

    // Positive control: management reads `all` in the entity, so the hide above is the scope, not a bad row.
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect((await listRows()).map((q) => q.id)).toContain(theirs.id);
      expect((await service.detail(theirs.id)).quotation.ownerUserId).toBe(otherUserId);
    });
  });
});

// --------------------------------------------------------------------------------------- update draft

/** A small one-line NPR draft, so a PUT of the golden lines visibly changes every figure. */
const smallBody = () =>
  goldenCreateBody(f, {
    lines: [
      {
        description: 'Discovery',
        uom: 'lot',
        quantity: '1',
        unitPrice: '1000.00',
        taxCodeId: f.taxCodeVat13Id,
      },
    ],
    discount: undefined,
  });

/** The row version of `versionId` as the API returns it. */
const rowVersionOf = async (quotationId: string, versionId: string): Promise<number> =>
  (await service.getVersion(quotationId, versionId)).version;

describe('DraftingService.updateDraft', () => {
  it('re-prices the golden lines to 2,690,999.99 and bumps the row version', async () => {
    const created = await service.create(smallBody(), 'put-golden');
    const before = await rowVersionOf(created.id, created.currentVersionId);

    const { version } = await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before,
      lines: goldenLines(f),
      discount: GOLDEN_DISCOUNT,
    });
    expect(version).toBe(before + 1);

    const after = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expect(after.version).toBe(version);
    expect(after.totals).toMatchObject(GOLDEN_TOTALS);
    expect(after.discount).toEqual(GOLDEN_DISCOUNT);
    expect(after.lines.map((l) => [l.lineNo, l.description])).toEqual([
      [1, 'Implementation'],
      [2, 'Licences'],
      [3, 'Training'],
    ]);
    const expected = await withTx(db, scopeA, systemActor('test'), (tx) =>
      pricing.priceVersion(tx, scopeA, pricingInputOf(goldenCreateBody(f))),
    );
    expect(after.taxSummary).toHaveLength(expected.taxSummary.length);

    const { rows: audit } = await ownerPool.query<{ action: string }>(
      `SELECT action FROM audit.audit_events WHERE tenant_id = $1 AND entity_id = $2 ORDER BY id`,
      [f.tenantId, created.id],
    );
    expect(audit.map((r) => r.action)).toContain('quotation.draft_updated');
  });

  it('keeps the saved lines and totals when the body changes only the text', async () => {
    const created = await service.create(goldenCreateBody(f), 'put-partial');
    const before = await service.getVersion(created.id, created.currentVersionId);
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before.version,
      scope: 'Phase 1 only',
    });
    const after = await service.getVersion(created.id, created.currentVersionId);
    expect(after.scope).toBe('Phase 1 only');
    expect(after.totals).toMatchObject(GOLDEN_TOTALS);
    expect(after.lines).toEqual(before.lines);
  });

  it('removes the discount when the body sends discount: null, and re-prices without it', async () => {
    const created = await service.create(
      goldenCreateBody(f, { scope: 'Phase 1 and 2' }),
      'put-clear-discount',
    );
    const before = await service.getVersion(created.id, created.currentVersionId);
    expect(before.discount).toEqual(GOLDEN_DISCOUNT);

    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before.version,
      discount: null,
      scope: null,
    });

    const after = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expect(after.discount).toBeNull();
    expect(after.scope).toBeNull();
    expect(after.totals.discountAmount).toBe('0.00');
    expect(after.totals.subtotal).toBe(GOLDEN_TOTALS.subtotal);
    expect(after.totals.taxableAmount).toBe(GOLDEN_TOTALS.subtotal);
    expect(after.totals.total).not.toBe(GOLDEN_TOTALS.total);
    expect(after.lines.map((l) => l.discountAlloc)).toEqual(after.lines.map(() => '0.00'));
  });

  it('answers 400 when the merged content has validUntil before the saved issueDate', async () => {
    const created = await service.create(goldenCreateBody(f), 'put-validity');
    const v = await rowVersionOf(created.id, created.currentVersionId);
    expect(
      await statusOf(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: v,
          validUntil: '2026-01-01',
        }),
      ),
    ).toBe(400);
  });

  it('answers 409 for a stale expectedVersion and changes nothing', async () => {
    const created = await service.create(smallBody(), 'put-stale');
    const v = await rowVersionOf(created.id, created.currentVersionId);
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: v,
      scope: 'First edit',
    });
    expect(
      await statusOf(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: v,
          lines: goldenLines(f),
        }),
      ),
    ).toBe(409);
    const after = await service.getVersion(created.id, created.currentVersionId);
    expect(after).toMatchObject({ version: v + 1, scope: 'First edit' });
    expect(after.lines).toHaveLength(1);
  });

  it('answers 409 for a version moved to Submitted, even with its current row version', async () => {
    const created = await service.create(smallBody(), 'put-submitted');
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions
               SET status = 'submitted', fx_rate = 1, amount_npr = total, npr_taxable_amount = taxable_amount,
                   content_sha256 = decode(${HASH_HEX}, 'hex'), snapshot_sha256 = decode(${HASH_HEX}, 'hex')
             WHERE tenant_id = ${f.tenantId} AND id = ${created.currentVersionId}`,
      ),
    );
    // Read back, so the 409 below is the status and not a stale row version.
    const submitted = await service.getVersion(created.id, created.currentVersionId);
    expect(submitted.status).toBe('submitted');
    expect(
      await statusOf(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: submitted.version,
          lines: goldenLines(f),
        }),
      ),
    ).toBe(409);
    const after = await service.getVersion(created.id, created.currentVersionId);
    expect(after).toMatchObject({ status: 'submitted', version: submitted.version });
    expect(after.lines).toHaveLength(1);
  });

  it("answers 404 for another owner's quotation under own scope", async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const theirs = await asLeadCreator(otherUserId, f.opportunityId, () =>
      service.create(smallBody(), 'put-other-owner'),
    );
    const v = await asCaller({ userId: otherUserId }, () =>
      rowVersionOf(theirs.id, theirs.currentVersionId),
    );
    expect(
      await statusOf(
        service.updateDraft(theirs.id, theirs.currentVersionId, {
          expectedVersion: v,
          scope: 'Not mine',
        }),
      ),
    ).toBe(404);
  });
});

// ----------------------------------------------------------------- demo feedback (2026-11-17) guards

/** A second opportunity of entity A for the fixture's customer, so a per-opportunity filter has something to drop. */
async function seedSecondOpportunity(): Promise<string> {
  const [row] = await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx
      .insert(opportunities)
      .values({
        ...scopeA,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: 'Second deal',
        customerId: f.customerPartyId,
        ownerUserId: f.ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id }),
  );
  return row!.id;
}

/** Moves a Draft version to Approved the way the workflow leaves it (submitted first), without an approval round trip. */
async function approve(versionId: string): Promise<void> {
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`UPDATE app.quotation_versions
             SET status = 'submitted', submitted_at = now(), version = version + 1,
                 content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea)
           WHERE id = ${versionId}`,
    );
    await tx.execute(
      sql`UPDATE app.quotation_versions SET status = 'approved', approved_at = now(), version = version + 1
           WHERE id = ${versionId}`,
    );
  });
}

describe('demo feedback guards', () => {
  it('lets Sales draft a quotation for a customer whose KYB is not verified', async () => {
    const approved = await db
      .select({ id: verificationCases.id })
      .from(verificationCases)
      .where(
        and(
          eq(verificationCases.partyId, f.customerPartyId),
          eq(verificationCases.status, 'approved'),
        ),
      );
    expect(approved).toEqual([]);
    const created = await service.create(goldenCreateBody(f), 'unverified-customer');
    expect(created).toMatchObject({ status: 'draft', customerId: f.customerPartyId });
  });

  it("lists one opportunity's quotations with opportunityId, and nothing for an unknown one", async () => {
    const second = await seedSecondOpportunity();
    const onFixture = await service.create(goldenCreateBody(f), 'filter-fixture-opp');
    const onSecond = await service.create(
      goldenCreateBody(f, { opportunityId: second }),
      'filter-second-opp',
    );

    const all = (await listRows()).map((q) => q.id);
    expect(all).toEqual(expect.arrayContaining([onFixture.id, onSecond.id]));

    const filtered = QuotationListItemSchema.array().parse(
      await listRows({ opportunityId: second }),
    );
    expect(filtered.map((q) => q.id)).toEqual([onSecond.id]);
    expect(
      (await listRows({ opportunityId: f.opportunityId })).every(
        (q) => q.opportunityId === f.opportunityId,
      ),
    ).toBe(true);
    expect(await listRows({ opportunityId: randomUUID() })).toEqual([]);
    // Combined with a status filter.
    expect((await listRows({ opportunityId: second, status: ['draft'] })).map((q) => q.id)).toEqual(
      [onSecond.id],
    );
    expect(await listRows({ opportunityId: second, status: ['sent'] })).toEqual([]);
  });

  it("never widens the read scope: another owner's quotation stays out of a filtered list", async () => {
    const second = await seedSecondOpportunity();
    const otherUserId = await seedOtherStaffUser(db, f);
    const theirs = await asLeadCreator(otherUserId, second, () =>
      service.create(goldenCreateBody(f, { opportunityId: second }), 'filter-other-owner'),
    );
    expect((await listRows({ opportunityId: second })).map((q) => q.id)).not.toContain(theirs.id);
  });

  it('marks a list row canEdit only for a Draft or Returned quotation the caller may edit', async () => {
    const second = await seedSecondOpportunity();
    const draft = await service.create(
      goldenCreateBody(f, { opportunityId: second }),
      'edit-row-1',
    );
    const approvedQ = await service.create(
      goldenCreateBody(f, { opportunityId: second }),
      'edit-row-2',
    );
    await approve(approvedQ.currentVersionId);

    const rows = new Map((await listRows({ opportunityId: second })).map((q) => [q.id, q.canEdit]));
    expect(rows.get(draft.id)).toBe(true);
    expect(rows.get(approvedQ.id)).toBe(false);

    // Management reads every quotation but drafts none: nothing is editable for it.
    await asCaller({ grants: grantsOf('management') }, async () => {
      const seen = await listRows({ opportunityId: second });
      expect(seen.map((q) => q.id)).toContain(draft.id);
      expect(seen.every((q) => !q.canEdit)).toBe(true);
    });
  });

  it('answers detail capabilities with the same rules as edit and revise', async () => {
    const created = await service.create(goldenCreateBody(f), 'caps-1');
    expect((await service.detail(created.id)).capabilities).toEqual({
      canEdit: true,
      canRevise: false,
      canSend: false,
      canRecordOutcome: false,
      canCancel: true,
    });

    await approve(created.currentVersionId);
    expect((await service.detail(created.id)).capabilities).toEqual({
      canEdit: false,
      canRevise: true,
      canSend: true,
      canRecordOutcome: false,
      canCancel: false,
    });

    // PMO reads all and drafts its own, but holds no quotation.revise: Revise would answer 403, so it is not offered.
    await asCaller({ grants: grantsOf('pmo') }, async () => {
      expect((await service.detail(created.id)).capabilities).toEqual({
        canEdit: false,
        canRevise: false,
        canSend: false,
        canRecordOutcome: false,
        canCancel: false,
      });
    });
  });

  it('offers Edit for a Returned version and the edit succeeds', async () => {
    const created = await service.create(goldenCreateBody(f), 'caps-returned');
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.execute(
        sql`UPDATE app.quotation_versions
               SET status = 'submitted', submitted_at = now(), version = version + 1,
                   content_sha256 = sha256('content'::bytea), snapshot_sha256 = sha256('snapshot'::bytea)
             WHERE id = ${created.currentVersionId}`,
      );
      await tx.execute(
        sql`UPDATE app.quotation_versions SET status = 'returned', version = version + 1
             WHERE id = ${created.currentVersionId}`,
      );
    });
    const detail = await service.detail(created.id);
    expect(detail.quotation.status).toBe('returned');
    expect(detail.capabilities.canEdit).toBe(true);
    const current = detail.versions.find((v) => v.id === created.currentVersionId)!;
    await expect(
      service.updateDraft(created.id, current.id, {
        expectedVersion: current.version,
        scope: 'Returned and fixed',
      }),
    ).resolves.toMatchObject({ version: current.version + 1 });
  });
});

// ------------------------------------------------------------- list filters, search, total and summary (U13)

/** A fresh customer of entity A with one opportunity, so a test's rows can be told from every other test's. */
async function seedCustomerWithOpportunity(
  legalName: string,
  scope: TxScope = scopeA,
): Promise<{ customerId: string; opportunityId: string }> {
  const { partyId } = await createParty(appPool, { tenantId: f.tenantId, kind: 'customer' });
  return withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
          VALUES (${partyId}, ${f.tenantId}, ${`CUS-${partyId.slice(0, 8)}`}, ${legalName},
                  ${legalName.toLowerCase()},
                  ${JSON.stringify({ line1: '3 Lazimpat', city: 'Kathmandu', country: 'NP' })}::jsonb)`,
    );
    const [row] = await tx
      .insert(opportunities)
      .values({
        ...scope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: `${legalName} deal`,
        customerId: partyId,
        ownerUserId: f.ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id });
    return { customerId: partyId, opportunityId: row!.id };
  });
}

describe('DraftingService.list filters and total', () => {
  it('filters by several statuses and customers, pages newest first and counts every match', async () => {
    const c1 = await seedCustomerWithOpportunity('Filter One Pvt. Ltd.');
    const c2 = await seedCustomerWithOpportunity('Filter Two Pvt. Ltd.');
    const q1 = await service.create(
      goldenCreateBody(f, { opportunityId: c1.opportunityId }),
      'list-f-1',
    );
    const q2 = await service.create(
      goldenCreateBody(f, { opportunityId: c1.opportunityId }),
      'list-f-2',
    );
    const q3 = await service.create(
      goldenCreateBody(f, { opportunityId: c2.opportunityId }),
      'list-f-3',
    );
    await approve(q2.currentVersionId);
    const both = [c1.customerId, c2.customerId];

    const one = await service.list({ customerId: [c1.customerId] });
    expect(one.rows.map((q) => q.id)).toEqual([q2.id, q1.id]);
    expect(one.total).toBe(2);

    const all = await service.list({ customerId: both });
    expect(all.rows.map((q) => q.id)).toEqual([q3.id, q2.id, q1.id]);
    expect(all.total).toBe(3);

    const approved = await service.list({ customerId: both, status: ['approved'] });
    expect(approved.rows.map((q) => q.id)).toEqual([q2.id]);
    expect(approved.total).toBe(1);
    const either = await service.list({ customerId: both, status: ['draft', 'approved'] });
    expect(either.total).toBe(3);
    expect((await service.list({ customerId: both, status: ['sent'] })).total).toBe(0);

    // Offset paging keeps the order and the total; past the end is an empty page with the same total.
    const first = await service.list({ customerId: both, limit: 2, offset: 0 });
    const second = await service.list({ customerId: both, limit: 2, offset: 2 });
    const past = await service.list({ customerId: both, limit: 2, offset: 6 });
    expect(first.rows.map((q) => q.id)).toEqual([q3.id, q2.id]);
    expect(second.rows.map((q) => q.id)).toEqual([q1.id]);
    expect([first.total, second.total, past.total]).toEqual([3, 3, 3]);
    expect(past.rows).toEqual([]);
  });

  it('returns every match when no limit is given, however many there are', async () => {
    const c = await seedCustomerWithOpportunity('Every Row Pvt. Ltd.');
    const created: string[] = [];
    for (let i = 0; i < 51; i += 1) {
      const q = await service.create(
        goldenCreateBody(f, { opportunityId: c.opportunityId }),
        `list-nolimit-${i}`,
      );
      created.push(q.id);
    }
    // More rows than any page default, so a hidden cap would drop the oldest one.
    const every = await service.list({ customerId: [c.customerId] });
    expect(every.total).toBe(51);
    expect(every.rows.map((q) => q.id).sort()).toEqual([...created].sort());
    const page = await service.list({ customerId: [c.customerId], limit: 50 });
    expect([page.rows.length, page.total]).toEqual([50, 51]);
  });

  it('searches the number, the customer name and close spellings of it', async () => {
    const himalyan = await seedCustomerWithOpportunity('Himalyan Traders Pvt Ltd');
    const made = await service.create(
      goldenCreateBody(f, { opportunityId: himalyan.opportunityId }),
      'list-q-1',
    );
    const filter = { customerId: [himalyan.customerId] };

    const byNumber = await service.list({ q: made.number });
    expect(byNumber.rows.map((q) => q.id)).toContain(made.id);
    expect((await service.list({ ...filter, q: 'traders' })).rows.map((q) => q.id)).toEqual([
      made.id,
    ]);
    // 'Himalayan' is not a substring of 'Himalyan'; few exact hits, so close matches are added.
    const fuzzy = await service.list({ q: 'Himalayan' });
    expect(fuzzy.rows.map((q) => q.id)).toContain(made.id);
    expect(fuzzy.total).toBeGreaterThanOrEqual(1);
    // A search that matches nothing, and a one-character search that is ignored.
    expect((await service.list({ ...filter, q: 'zzzzqqqq' })).total).toBe(0);
    expect((await service.list({ ...filter, q: 'z' })).total).toBe(1);
  });

  it('never widens the read scope for a status, customer or search filter', async () => {
    const c = await seedCustomerWithOpportunity('Scope Probe Himalyan Ltd');
    const otherUserId = await seedOtherStaffUser(db, f);
    const mine = await service.create(
      goldenCreateBody(f, { opportunityId: c.opportunityId }),
      'list-scope-mine',
    );
    const theirs = await asLeadCreator(otherUserId, c.opportunityId, () =>
      service.create(goldenCreateBody(f, { opportunityId: c.opportunityId }), 'list-scope-theirs'),
    );
    const scopeB: TxScope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    const cb = await seedCustomerWithOpportunity('Scope Probe Himalyan Ltd', scopeB);
    const elsewhere = await asCaller({ scope: scopeB }, () =>
      service.create(
        goldenCreateBody(f, { opportunityId: cb.opportunityId }),
        'list-scope-other-entity',
      ),
    );

    const probes: Partial<ListQuotationsQuery>[] = [
      { customerId: [c.customerId, cb.customerId] },
      { customerId: [c.customerId], status: ['draft'] },
      { q: 'Scope Probe' },
      { q: 'Scope Probe Himalayan' },
    ];
    for (const probe of probes) {
      const seen = await service.list({ limit: 100, ...probe });
      const ids = seen.rows.map((q) => q.id);
      expect(ids, JSON.stringify(probe)).toContain(mine.id);
      expect(ids, JSON.stringify(probe)).not.toContain(theirs.id);
      expect(ids, JSON.stringify(probe)).not.toContain(elsewhere.id);
      // The count follows the same scope: it never includes a row the page cannot show.
      expect(seen.total).toBe(seen.rows.length);
    }
    // Positive control: a read-all role sees the colleague's row, still not the other entity's.
    await asCaller({ grants: grantsOf('management') }, async () => {
      const ids = (await service.list({ limit: 100, customerId: [c.customerId] })).rows.map(
        (q) => q.id,
      );
      expect(ids).toEqual(expect.arrayContaining([mine.id, theirs.id]));
      expect(ids).not.toContain(elsewhere.id);
    });
  });
});

describe('DraftingService.summary', () => {
  it('counts per current status for the list filters except status, and adds up to the list total', async () => {
    const c1 = await seedCustomerWithOpportunity('Summary One Pvt. Ltd.');
    const c2 = await seedCustomerWithOpportunity('Summary Two Pvt. Ltd.');
    await service.create(goldenCreateBody(f, { opportunityId: c1.opportunityId }), 'sum-1');
    const approvedQ = await service.create(
      goldenCreateBody(f, { opportunityId: c1.opportunityId }),
      'sum-2',
    );
    await service.create(goldenCreateBody(f, { opportunityId: c2.opportunityId }), 'sum-3');
    await approve(approvedQ.currentVersionId);

    const summary = QuotationSummarySchema.parse(
      await service.summary({ customerId: [c1.customerId, c2.customerId] }),
    );
    expect(summary.total).toBe(3);
    expect(summary.byStatus).toMatchObject({ draft: 2, approved: 1, sent: 0, accepted: 0 });
    expect(Object.values(summary.byStatus).reduce((a, b) => a + b, 0)).toBe(summary.total);
    // The worth per status adds up the same current-version totals the list shows, per currency.
    const listed = (await service.list({ customerId: [c1.customerId, c2.customerId] })).rows;
    for (const status of ['draft', 'approved'] as const) {
      const expected = new Map<string, Decimal>();
      for (const row of listed.filter((r) => r.status === status)) {
        expected.set(row.currency, (expected.get(row.currency) ?? new Decimal(0)).plus(row.total));
      }
      const got = new Map((summary.amounts?.[status] ?? []).map((a) => [a.currency, a.total]));
      expect([...got.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [currency, sum] of expected)
        expect(new Decimal(got.get(currency as never)!).eq(sum)).toBe(true);
    }
    expect(summary.amounts?.sent).toEqual([]);
    expect((await service.list({ customerId: [c1.customerId, c2.customerId] })).total).toBe(
      summary.total,
    );

    const oneCustomer = await service.summary({ customerId: [c2.customerId] });
    expect(oneCustomer).toMatchObject({ total: 1, byStatus: { draft: 1, approved: 0 } });
    const byOpportunity = await service.summary({ opportunityId: c1.opportunityId });
    expect(byOpportunity.total).toBe(2);
    expect((await service.summary({ customerId: [randomUUID()] })).total).toBe(0);
    expect(
      QuotationSummarySchema.parse(await service.summary({ customerId: [randomUUID()] })).byStatus
        .draft,
    ).toBe(0);
  });

  it('searches like the list, including close matches, and never counts outside the read scope', async () => {
    const c = await seedCustomerWithOpportunity('Summary Himalyan Traders');
    const otherUserId = await seedOtherStaffUser(db, f);
    await service.create(goldenCreateBody(f, { opportunityId: c.opportunityId }), 'sum-q-mine');
    await asLeadCreator(otherUserId, c.opportunityId, () =>
      service.create(goldenCreateBody(f, { opportunityId: c.opportunityId }), 'sum-q-theirs'),
    );
    const scopeB: TxScope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    const cb = await seedCustomerWithOpportunity('Summary Himalyan Traders', scopeB);
    await asCaller({ scope: scopeB }, () =>
      service.create(goldenCreateBody(f, { opportunityId: cb.opportunityId }), 'sum-q-entity-b'),
    );

    for (const q of ['Summary Himalyan', 'Summary Himalayan']) {
      const summary = await service.summary({ q });
      const list = await service.list({ q, limit: 100 });
      expect(summary.total, q).toBe(list.total);
      expect(
        Object.values(summary.byStatus).reduce((a, b) => a + b, 0),
        q,
      ).toBe(summary.total);
    }
    const mineOnly = await service.summary({ q: 'Summary Himalyan', customerId: [c.customerId] });
    expect(mineOnly.total).toBe(1);
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect(
        (await service.summary({ q: 'Summary Himalyan', customerId: [c.customerId] })).total,
      ).toBe(2);
    });
  });
});

// ------------------------------------------------------------------------------------------ cost figures

// D29b: unitCost, internalCostTotal and marginPct leave the API only for a caller whose LIVE grants hold
// quotation.cost.read. The grants here come from the real RoleCache over real app.role_permissions rows, and a
// change is published with AuthzService.invalidate (the authz_versions bump), as an admin's role edit does.
describe('quotation cost figures follow the live role grants (D29b)', () => {
  let roleCache: RoleCache;
  let liveAuthz: AuthzService;

  beforeAll(() => {
    roleCache = new RoleCache(db);
    liveAuthz = new AuthzService(db, roleCache);
  });
  afterAll(async () => {
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.tenantId, f.tenantId));
    });
    await liveAuthz.invalidate(f.tenantId, f.entityId);
  });

  /** The tenant's rows: `sales` as customised (with or without the cost grant), `operations_head` as shipped. */
  async function customiseRoles(salesMayReadCost: boolean): Promise<void> {
    const rows = (['sales', 'operations_head'] as const).flatMap((roleKey) =>
      [...grantsOf(roleKey)]
        .filter(
          ([permission]) =>
            !(roleKey === 'sales' && !salesMayReadCost && permission === 'quotation.cost.read'),
        )
        .map(([permission, scope]) => ({ tenantId: f.tenantId, roleKey, permission, scope })),
    );
    await withTx(db, scopeA, systemActor('test'), async (tx) => {
      await tx.delete(rolePermissions).where(eq(rolePermissions.tenantId, f.tenantId));
      await tx.insert(rolePermissions).values(rows);
    });
    await liveAuthz.invalidate(f.tenantId, f.entityId);
  }
  /** The caller's grants as the request would read them now: the real cache over the real rows. */
  const live = async (role: RoleKey): Promise<Map<Permission, Scope>> =>
    new Map(await roleCache.grantsFor(f.tenantId, f.entityId, [role])) as Map<Permission, Scope>;

  const costedBody = () => goldenCreateBody(f, { lines: goldenCostedLines(f) });
  const storedLines = (versionId: string) =>
    db
      .select()
      .from(quotationLines)
      .where(eq(quotationLines.versionId, versionId))
      .orderBy(asc(quotationLines.lineNo));
  const storedVersion = async (versionId: string) => {
    const [row] = await db
      .select()
      .from(quotationVersions)
      .where(eq(quotationVersions.id, versionId));
    return row!;
  };
  const expectNoCostKeys = (v: { lines: readonly object[] }) => {
    expect('internalCostTotal' in v).toBe(false);
    expect('marginPct' in v).toBe(false);
    for (const line of v.lines) expect('unitCost' in line).toBe(false);
  };

  it('shows the figures to a role that holds quotation.cost.read and drops them for the same role once it is removed', async () => {
    await customiseRoles(true);
    current.grants = await live('sales');
    expect(current.grants.has('quotation.cost.read')).toBe(true);
    const created = await service.create(costedBody(), 'cost-read-1');

    const shown = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expect(shown.internalCostTotal).toBe(GOLDEN_INTERNAL_COST);
    expect(shown.marginPct).toMatch(/^-?\d+\.\d{4}$/);
    expect(shown.lines.map((l) => l.unitCost)).toEqual([...GOLDEN_UNIT_COSTS]);
    const shownDetail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(shownDetail.versions[0]).toEqual(shown);

    // The admin removes the permission from the role; the bump makes the next request see it at once.
    await customiseRoles(false);
    current.grants = await live('sales');
    expect(current.grants.has('quotation.cost.read')).toBe(false);
    expect(current.grants.has('quotation.draft')).toBe(true);

    const hidden = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expectNoCostKeys(hidden);
    // Everything else is untouched.
    expect(hidden.totals).toEqual(shown.totals);
    expect(hidden.lines.map((l) => l.unitPrice)).toEqual(shown.lines.map((l) => l.unitPrice));
    const hiddenDetail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(hiddenDetail.versions.length).toBeGreaterThan(0);
    hiddenDetail.versions.forEach(expectNoCostKeys);

    // Granted back: the figures return, and the stored costs were never touched.
    await customiseRoles(true);
    current.grants = await live('sales');
    expect((await service.getVersion(created.id, created.currentVersionId)).internalCostTotal).toBe(
      GOLDEN_INTERNAL_COST,
    );
  });

  it('shows no figures to a reader whose role never had the permission (operations_head)', async () => {
    await customiseRoles(true);
    current.grants = await live('sales');
    const created = await service.create(costedBody(), 'cost-read-2');

    current.grants = await live('operations_head');
    expect(current.grants.has('quotation.read')).toBe(true);
    expect(current.grants.has('quotation.cost.read')).toBe(false);
    const dto = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expectNoCostKeys(dto);
    QuotationDetailSchema.parse(await service.detail(created.id)).versions.forEach(
      expectNoCostKeys,
    );
  });

  it('keeps the stored costs when a drafter without the permission saves lines that omit them, and recomputes the totals from them', async () => {
    await customiseRoles(true);
    current.grants = await live('sales');
    const created = await service.create(costedBody(), 'cost-save-1');
    const before = await storedVersion(created.currentVersionId);
    expect(before.internalCostTotal).toBe(GOLDEN_INTERNAL_COST);

    await customiseRoles(false);
    current.grants = await live('sales');
    // The workspace sends the lines it was shown: no unitCost anywhere. Line 1 now sells two; line 2 tries to
    // set a cost, which a drafter without the permission cannot do.
    const lines = goldenLines(f).map((l, i) => ({
      ...l,
      ...(i === 0 ? { quantity: '2' } : {}),
      ...(i === 1 ? { unitCost: '1.00' } : {}),
    }));
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before.version,
      lines,
    });

    const stored = await storedLines(created.currentVersionId);
    expect(stored.map((l) => l.unitCost)).toEqual([...GOLDEN_UNIT_COSTS]);
    expect(stored[0]!.quantity).toMatch(/^2(\.0+)?$/);
    // 2 x 1,000,000 + 1 x 400,000 + 3 x 20,000: the preserved costs, not the attempted 1.00.
    const after = await storedVersion(created.currentVersionId);
    expect(after.internalCostTotal).toBe('2460000.00');
    expect(after.marginPct).not.toBeNull();

    // A text-only save keeps them too.
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: after.version,
      scope: 'Phase 1 only',
    });
    expect((await storedLines(created.currentVersionId)).map((l) => l.unitCost)).toEqual([
      ...GOLDEN_UNIT_COSTS,
    ]);
    expect((await storedVersion(created.currentVersionId)).internalCostTotal).toBe('2460000.00');

    // The permitted viewer reads the preserved figures.
    await customiseRoles(true);
    current.grants = await live('sales');
    const seen = await service.getVersion(created.id, created.currentVersionId);
    expect(seen.internalCostTotal).toBe('2460000.00');
  });

  describe('a drafter without the permission cannot change which lines a costed quotation has', () => {
    /** A costed quotation, then the caller loses quotation.cost.read. */
    async function costedThenRestricted(key: string) {
      await customiseRoles(true);
      current.grants = await live('sales');
      const created = await service.create(costedBody(), key);
      const before = await storedVersion(created.currentVersionId);
      await customiseRoles(false);
      current.grants = await live('sales');
      return { created, before };
    }
    const restricted = async (promise: Promise<unknown>) => {
      const error = await promise.then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({
        code: 'cost_figures_restricted',
      });
    };
    /** Nothing was written: every line keeps its cost and the version is untouched. */
    async function expectUntouched(versionId: string, version: number) {
      const stored = await storedLines(versionId);
      expect(stored.map((l) => l.description)).toEqual(['Implementation', 'Licences', 'Training']);
      expect(stored.map((l) => l.unitCost)).toEqual([...GOLDEN_UNIT_COSTS]);
      const row = await storedVersion(versionId);
      expect(row.version).toBe(version);
      expect(row.internalCostTotal).toBe(GOLDEN_INTERNAL_COST);
    }

    it('drafter without cost read deletes line 1: refused, stored unit_cost of every line unchanged', async () => {
      const { created, before } = await costedThenRestricted('cost-del-1');
      await restricted(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: before.version,
          lines: goldenLines(f).slice(1),
        }),
      );
      await expectUntouched(created.currentVersionId, before.version);
    });

    it('refuses a reorder', async () => {
      const { created, before } = await costedThenRestricted('cost-reorder-1');
      const [first, second, third] = goldenLines(f);
      await restricted(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: before.version,
          lines: [second!, first!, third!],
        }),
      );
      await expectUntouched(created.currentVersionId, before.version);
    });

    it('refuses an inserted line and an appended line', async () => {
      const { created, before } = await costedThenRestricted('cost-insert-1');
      const lines = goldenLines(f);
      const extra = { ...lines[0]!, description: 'Extra', unitCost: '5.00' };
      await restricted(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: before.version,
          lines: [lines[0]!, extra, lines[1]!, lines[2]!],
        }),
      );
      await restricted(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: before.version,
          lines: [...lines, extra],
        }),
      );
      await expectUntouched(created.currentVersionId, before.version);
    });

    it('refuses an edit of a stored line identity (its description)', async () => {
      const { created, before } = await costedThenRestricted('cost-identity-1');
      await restricted(
        service.updateDraft(created.id, created.currentVersionId, {
          expectedVersion: before.version,
          lines: goldenLines(f).map((l, i) => (i === 1 ? { ...l, description: 'Renamed' } : l)),
        }),
      );
      await expectUntouched(created.currentVersionId, before.version);
    });

    it('allows a same-structure edit (quantity, price): costs kept, totals recomputed from them', async () => {
      const { created, before } = await costedThenRestricted('cost-same-1');
      await service.updateDraft(created.id, created.currentVersionId, {
        expectedVersion: before.version,
        lines: goldenLines(f).map((l, i) =>
          i === 0 ? { ...l, quantity: '2', unitPrice: '1900000.00' } : l,
        ),
      });
      const stored = await storedLines(created.currentVersionId);
      expect(stored.map((l) => l.unitCost)).toEqual([...GOLDEN_UNIT_COSTS]);
      expect(stored[0]!.unitPrice).toBe('1900000.00');
      const after = await storedVersion(created.currentVersionId);
      expect(after.internalCostTotal).toBe('2460000.00');
      expect(after.marginPct).not.toBeNull();
    });

    it('lets a drafter who holds the permission delete a line, as before: the other lines keep their own costs', async () => {
      await customiseRoles(true);
      current.grants = await live('sales');
      const created = await service.create(costedBody(), 'cost-del-2');
      const before = await storedVersion(created.currentVersionId);
      await service.updateDraft(created.id, created.currentVersionId, {
        expectedVersion: before.version,
        lines: goldenCostedLines(f).slice(1),
      });
      const stored = await storedLines(created.currentVersionId);
      expect(stored.map((l) => l.description)).toEqual(['Licences', 'Training']);
      expect(stored.map((l) => l.unitCost)).toEqual(['400000.00', '20000.00']);
    });
  });

  it('stores no cost for a quotation created by a drafter without the permission', async () => {
    await customiseRoles(false);
    current.grants = await live('sales');
    const created = await service.create(costedBody(), 'cost-create-1');
    expect((await storedLines(created.currentVersionId)).map((l) => l.unitCost)).toEqual([
      null,
      null,
      null,
    ]);
    const stored = await storedVersion(created.currentVersionId);
    expect(stored.internalCostTotal).toBeNull();
    expect(stored.marginPct).toBeNull();
  });

  it('still lets a drafter who holds the permission clear or change a cost, as before', async () => {
    await customiseRoles(true);
    current.grants = await live('sales');
    const created = await service.create(costedBody(), 'cost-save-3');
    const before = await storedVersion(created.currentVersionId);

    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before.version,
      lines: goldenCostedLines(f).map((l, i) => (i === 2 ? { ...l, unitCost: '30000.00' } : l)),
    });
    expect((await storedLines(created.currentVersionId)).map((l) => l.unitCost)).toEqual([
      '1000000.00',
      '400000.00',
      '30000.00',
    ]);
    expect((await storedVersion(created.currentVersionId)).internalCostTotal).toBe('1490000.00');

    const mid = await storedVersion(created.currentVersionId);
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: mid.version,
      lines: goldenLines(f),
    });
    expect((await storedLines(created.currentVersionId)).map((l) => l.unitCost)).toEqual([
      null,
      null,
      null,
    ]);
  });
});

// ------------------------------------------------------------------ D35 lead and D36 schedule amounts

/** A lead of `scope` owned by `ownerUserId`, and an opportunity of the same entity that hangs under it. */
async function seedLeadOpportunity(
  scope: TxScope,
  ownerUserId: string,
  title: string,
): Promise<{ leadId: string; opportunityId: string }> {
  return withTx(db, scope, systemActor('test'), async (tx) => {
    const [lead] = await tx
      .insert(leads)
      .values({
        ...scope,
        number: `LD-${randomUUID().slice(0, 8)}`,
        title,
        source: 'website',
        ownerUserId,
        companyName: 'Acme Pvt. Ltd.',
        contactName: 'Asha Shrestha',
      })
      .returning({ id: leads.id });
    const [opportunity] = await tx
      .insert(opportunities)
      .values({
        ...scope,
        number: `DEAL-${randomUUID().slice(0, 8)}`,
        name: `Deal of ${title}`,
        customerId: f.customerPartyId,
        leadId: lead!.id,
        ownerUserId,
        stage: 'qualified',
      })
      .returning({ id: opportunities.id });
    return { leadId: lead!.id, opportunityId: opportunity!.id };
  });
}

describe('DraftingService.detail lead (D35)', () => {
  it('gives the lead of the opportunity to a viewer who may read it', async () => {
    const { leadId, opportunityId } = await seedLeadOpportunity(
      scopeA,
      f.ownerUserId,
      'Own enquiry',
    );
    const created = await service.create(goldenCreateBody(f, { opportunityId }), 'lead-own');
    // sales holds crm.lead.read as `own` and owns this lead.
    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(detail.lead).toEqual({ id: leadId, name: 'Own enquiry' });

    // A read-all role sees it too.
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect((await service.detail(created.id)).lead).toEqual({ id: leadId, name: 'Own enquiry' });
    });
  });

  it("leaves the lead out when sales holds `own` scope and the lead is someone else's", async () => {
    const otherUserId = await seedOtherStaffUser(db, f);
    const { leadId, opportunityId } = await seedLeadOpportunity(
      scopeA,
      otherUserId,
      'Their enquiry',
    );
    // Quoting on another owner's opportunity needs a tie to it (R4a Q4 a); the lead stays under `own`.
    const created = await asLeadCreator(f.ownerUserId, opportunityId, () =>
      service.create(goldenCreateBody(f, { opportunityId }), 'lead-theirs'),
    );

    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect('lead' in detail).toBe(false);
    expect(JSON.stringify(detail)).not.toContain(leadId);

    // Positive control: the same quotation shows the lead to a read-all role, so the omission is the scope.
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect((await service.detail(created.id)).lead).toEqual({
        id: leadId,
        name: 'Their enquiry',
      });
    });
  });

  it('leaves the lead out for a viewer who holds no crm.lead.read at all', async () => {
    const { opportunityId } = await seedLeadOpportunity(scopeA, f.ownerUserId, 'Own enquiry 2');
    const created = await service.create(goldenCreateBody(f, { opportunityId }), 'lead-no-grant');
    const grants = new Map(grantsOf('sales'));
    grants.delete('crm.lead.read');
    await asCaller({ grants }, async () => {
      expect('lead' in (await service.detail(created.id))).toBe(false);
    });
  });

  it('leaves the lead out when the opportunity has no lead, exactly as for a hidden one', async () => {
    // The fixture opportunity has no lead. (quotations.opportunity_id is NOT NULL, so "no opportunity" cannot occur.)
    const created = await service.create(goldenCreateBody(f), 'lead-none');
    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect('lead' in detail).toBe(false);
  });

  it("never shows a lead of another entity: it is read in its own entity, and A's detail does not carry B's", async () => {
    const scopeB: TxScope = { tenantId: f.tenantId, organizationId: f.otherEntityId };
    const b = await seedLeadOpportunity(scopeB, f.ownerUserId, 'Entity B enquiry');
    const inB = await asCaller({ scope: scopeB }, () =>
      service.create(goldenCreateBody(f, { opportunityId: b.opportunityId }), 'lead-entity-b'),
    );
    // Positive control: entity B's own caller reads it.
    await asCaller({ scope: scopeB }, async () => {
      expect((await service.detail(inB.id)).lead).toEqual({
        id: b.leadId,
        name: 'Entity B enquiry',
      });
    });
    // Entity A cannot reach the quotation, and an entity-A quotation never names B's lead.
    expect(await statusOf(service.detail(inB.id))).toBe(404);
    const inA = await service.create(goldenCreateBody(f), 'lead-entity-a');
    expect(JSON.stringify(await service.detail(inA.id))).not.toContain(b.leadId);
  });
});

describe('DraftingService payment schedule amounts (D36)', () => {
  it('returns each milestone with its amount, remainder on the last row, on detail and getVersion', async () => {
    const created = await service.create(
      goldenCreateBody(f, {
        paymentSchedule: [
          { label: 'Advance', percent: '33.3333', dueDescription: 'On order' },
          { label: 'Delivery', percent: '33.3333' },
          { label: 'Go-live', percent: '33.3334' },
        ],
      }),
      'schedule-amounts',
    );
    const detail = QuotationDetailSchema.parse(await service.detail(created.id));
    expect(detail.versions[0]!.totals.total).toBe(GOLDEN_TOTALS.total);
    expect(detail.versions[0]!.paymentSchedule).toEqual([
      { label: 'Advance', percent: '33.3333', dueDescription: 'On order', amount: '896999.10' },
      { label: 'Delivery', percent: '33.3333', amount: '896999.10' },
      { label: 'Go-live', percent: '33.3334', amount: '897001.79' },
    ]);
    const version = QuotationVersionDtoSchema.parse(
      await service.getVersion(created.id, created.currentVersionId),
    );
    expect(version.paymentSchedule).toEqual(detail.versions[0]!.paymentSchedule);

    // The stored jsonb stays amount-free, and a later draft save (merge base from the DTO) still works.
    const stored = await db
      .select({ paymentSchedule: quotationVersions.paymentSchedule })
      .from(quotationVersions)
      .where(eq(quotationVersions.id, created.currentVersionId));
    expect(JSON.stringify(stored[0]!.paymentSchedule)).not.toContain('amount');
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: version.version,
      scope: 'Changed scope',
    });
    expect(
      (await service.getVersion(created.id, created.currentVersionId)).paymentSchedule,
    ).toEqual(version.paymentSchedule);
  });
});

describe('saved reach on quotations (U20a phase 2)', () => {
  /**
   * A quotation owned by a colleague filed in a new department: their membership names it (department row first,
   * then the membership, D55-8), so the opportunity they own is stamped with it (0080) and the quotation copies the
   * opportunity's (0088).
   */
  async function colleagueQuotation(): Promise<{
    id: string;
    versionId: string;
    departmentId: string;
  }> {
    const colleague = await seedOtherStaffUser(db, f);
    const { departmentId } = await createDepartment(appPool, scopeA);
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.user_entities SET department_id = ${departmentId}
            WHERE tenant_id = ${scopeA.tenantId} AND organization_id = ${scopeA.organizationId}
              AND user_id = ${colleague}`,
      ),
    );
    const [opportunity] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(opportunities)
        .values({
          ...scopeA,
          number: `DEAL-${randomUUID().slice(0, 8)}`,
          name: 'Department deal',
          customerId: f.customerPartyId,
          ownerUserId: colleague,
          stage: 'qualified',
        })
        .returning({ id: opportunities.id }),
    );
    const created = await asCaller({ userId: colleague }, () =>
      service.create(
        goldenCreateBody(f, { opportunityId: opportunity!.id }),
        `dept-${randomUUID()}`,
      ),
    );
    const [row] = await db
      .select({ departmentId: quotations.departmentId })
      .from(quotations)
      .where(eq(quotations.id, created.id));
    expect(row!.departmentId).toBe(departmentId);
    return { id: created.id, versionId: created.currentVersionId, departmentId };
  }

  const ids = async () => (await listRows()).map((q) => q.id);
  const edit = async (q: { id: string; versionId: string }) =>
    service.updateDraft(q.id, q.versionId, {
      expectedVersion: await rowVersionOf(q.id, q.versionId),
      discount: GOLDEN_DISCOUNT,
    });

  it('department reads and edits the department quotations; own stays out; list, detail and capability agree', async () => {
    const theirs = await colleagueQuotation();
    current.departmentId = theirs.departmentId;

    // Sales' own reach (the default): out of view everywhere.
    expect(await ids()).not.toContain(theirs.id);
    expect(await statusOf(service.detail(theirs.id))).toBe(404);

    // Department read only: visible, still not editable (quotation.draft stays own).
    current.grants = new Map([...grantsOf('sales'), ['quotation.read', 'department']]);
    expect(await ids()).toContain(theirs.id);
    expect((await service.detail(theirs.id)).capabilities.canEdit).toBe(false);
    expect(await statusOf(edit(theirs))).toBe(403);

    // Department drafting too: the capability and the command both pass on the stored department.
    current.grants = new Map([
      ...grantsOf('sales'),
      ['quotation.read', 'department'],
      ['quotation.draft', 'department'],
    ]);
    expect((await service.detail(theirs.id)).capabilities.canEdit).toBe(true);
    await expect(edit(theirs)).resolves.toMatchObject({ version: expect.any(Number) as number });

    // Another department reaches nothing of it.
    current.departmentId = (await createDepartment(appPool, scopeA)).departmentId;
    expect(await ids()).not.toContain(theirs.id);
    expect(await statusOf(service.detail(theirs.id))).toBe(404);

    // Founder-style `all` reads it whatever the department.
    current.grants = grantsOf('founder');
    expect(await ids()).toContain(theirs.id);
  });

  it('assigned reads only the quotation the caller holds a live follow-up on, read only', async () => {
    const theirs = await colleagueQuotation();
    const other = await colleagueQuotation();
    const [followUp] = await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .insert(activities)
        .values({
          ...scopeA,
          kind: 'call',
          subject: 'Walk the client through the quotation',
          quotationId: theirs.id,
          assigneeUserId: f.ownerUserId,
          dueAt: new Date('2026-12-01T05:00:00Z'),
        })
        .returning({ id: activities.id }),
    );
    // `assigned` is not in the `Scope` union the role constant uses; the principal holds AccessScope.
    const assigned = 'assigned' as AccessScope as Scope;
    current.grants = new Map([...grantsOf('sales'), ['quotation.read', assigned]]);
    const listed = await ids();
    expect(listed).toContain(theirs.id);
    expect(listed).not.toContain(other.id);
    expect((await service.detail(theirs.id)).capabilities).toEqual({
      canEdit: false,
      canRevise: false,
      canSend: false,
      canRecordOutcome: false,
      canCancel: false,
    });
    expect(await statusOf(service.detail(other.id))).toBe(404);
    expect(await statusOf(edit(theirs))).toBe(403);

    // A cancelled follow-up hands nothing over.
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx
        .update(activities)
        .set({ cancelledAt: new Date('2026-11-20T05:00:00Z') })
        .where(eq(activities.id, followUp!.id)),
    );
    expect(await ids()).not.toContain(theirs.id);
    expect(await statusOf(service.detail(theirs.id))).toBe(404);
  });
});
