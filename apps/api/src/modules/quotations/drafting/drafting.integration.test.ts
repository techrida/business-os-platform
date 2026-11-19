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
  DEFAULT_ROLE_PERMISSIONS,
  QuotationDetailSchema,
  QuotationDtoSchema,
  QuotationListItemSchema,
  QuotationVersionDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  opportunities,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  rolePermissions,
  runMigrations,
  verificationCases,
} from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { and, asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { RoleCache } from '../../../platform/authz/role-cache';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { PricingService } from '../pricing/pricing.service';
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

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
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
const current: { grants: Map<Permission, Scope>; userId: string | null; scope: TxScope | null } = {
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
  roles: [],
  departmentId: null,
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

const urlFor = (user: string, password: string, database: string) => {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
};

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin0 = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin0.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin0.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin0.query('CREATE DATABASE bos OWNER bos_owner');
  await admin0.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();
  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  ownerPool = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 8 });
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
  );
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await container?.stop();
});

beforeEach(() => {
  current.grants = grantsOf('sales');
  current.userId = null;
  current.scope = null;
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
  who: { userId?: string; scope?: TxScope; grants?: Map<Permission, Scope> },
  fn: () => Promise<T>,
): Promise<T> {
  const saved = { ...current };
  current.userId = who.userId ?? current.userId;
  current.scope = who.scope ?? current.scope;
  current.grants = who.grants ?? current.grants;
  try {
    return await fn();
  } finally {
    Object.assign(current, saved);
  }
}

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

describe('DraftingService reads', () => {
  it('lists, details and returns one version in the contract shapes', async () => {
    const contactId = await seedCustomerContact('Asha Shrestha');
    const created = await service.create(goldenCreateBody(f), 'read-shapes');

    const list = QuotationListItemSchema.array().parse(await service.list());
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
    expect((await service.list({ status: 'draft' })).map((q) => q.id)).toContain(created.id);
    expect((await service.list({ status: 'submitted' })).map((q) => q.id)).not.toContain(
      created.id,
    );

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
    expect((await service.list()).map((q) => q.id)).not.toContain(other.id);
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
    const theirs = await asCaller({ userId: otherUserId }, () =>
      service.create(goldenCreateBody(f), 'read-other-owner'),
    );
    expect(theirs.ownerUserId).toBe(otherUserId);

    // sales holds quotation.read as `own`.
    expect((await service.list()).map((q) => q.id)).not.toContain(theirs.id);
    expect(await statusOf(service.detail(theirs.id))).toBe(404);
    expect(await statusOf(service.getVersion(theirs.id, theirs.currentVersionId))).toBe(404);

    // Positive control: management reads `all` in the entity, so the hide above is the scope, not a bad row.
    await asCaller({ grants: grantsOf('management') }, async () => {
      expect((await service.list()).map((q) => q.id)).toContain(theirs.id);
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
    const theirs = await asCaller({ userId: otherUserId }, () =>
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

    const all = (await service.list()).map((q) => q.id);
    expect(all).toEqual(expect.arrayContaining([onFixture.id, onSecond.id]));

    const filtered = QuotationListItemSchema.array().parse(
      await service.list({ opportunityId: second }),
    );
    expect(filtered.map((q) => q.id)).toEqual([onSecond.id]);
    expect(
      (await service.list({ opportunityId: f.opportunityId })).every(
        (q) => q.opportunityId === f.opportunityId,
      ),
    ).toBe(true);
    expect(await service.list({ opportunityId: randomUUID() })).toEqual([]);
    // Combined with a status filter.
    expect(
      (await service.list({ opportunityId: second, status: 'draft' })).map((q) => q.id),
    ).toEqual([onSecond.id]);
    expect(await service.list({ opportunityId: second, status: 'sent' })).toEqual([]);
  });

  it("never widens the read scope: another owner's quotation stays out of a filtered list", async () => {
    const second = await seedSecondOpportunity();
    const otherUserId = await seedOtherStaffUser(db, f);
    const theirs = await asCaller({ userId: otherUserId }, () =>
      service.create(goldenCreateBody(f, { opportunityId: second }), 'filter-other-owner'),
    );
    expect((await service.list({ opportunityId: second })).map((q) => q.id)).not.toContain(
      theirs.id,
    );
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

    const rows = new Map(
      (await service.list({ opportunityId: second })).map((q) => [q.id, q.canEdit]),
    );
    expect(rows.get(draft.id)).toBe(true);
    expect(rows.get(approvedQ.id)).toBe(false);

    // Management reads every quotation but drafts none: nothing is editable for it.
    await asCaller({ grants: grantsOf('management') }, async () => {
      const seen = await service.list({ opportunityId: second });
      expect(seen.map((q) => q.id)).toContain(draft.id);
      expect(seen.every((q) => !q.canEdit)).toBe(true);
    });
  });

  it('answers detail capabilities with the same rules as edit and revise', async () => {
    const created = await service.create(goldenCreateBody(f), 'caps-1');
    expect((await service.detail(created.id)).capabilities).toEqual({
      canEdit: true,
      canRevise: false,
    });

    await approve(created.currentVersionId);
    expect((await service.detail(created.id)).capabilities).toEqual({
      canEdit: false,
      canRevise: true,
    });

    // PMO reads all and drafts its own, but holds no quotation.revise: Revise would answer 403, so it is not offered.
    await asCaller({ grants: grantsOf('pmo') }, async () => {
      expect((await service.detail(created.id)).capabilities).toEqual({
        canEdit: false,
        canRevise: false,
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
    new Map(await roleCache.grantsFor(f.tenantId, f.entityId, [role]));

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

  it('gives a line number that did not exist before no cost, so the total cost is unknown again', async () => {
    await customiseRoles(true);
    current.grants = await live('sales');
    const created = await service.create(costedBody(), 'cost-save-2');
    const before = await storedVersion(created.currentVersionId);

    await customiseRoles(false);
    current.grants = await live('sales');
    await service.updateDraft(created.id, created.currentVersionId, {
      expectedVersion: before.version,
      lines: [...goldenLines(f), { ...goldenLines(f)[0]!, description: 'Extra', unitCost: '5.00' }],
    });

    const stored = await storedLines(created.currentVersionId);
    expect(stored.map((l) => l.unitCost)).toEqual([...GOLDEN_UNIT_COSTS, null]);
    const after = await storedVersion(created.currentVersionId);
    expect(after.internalCostTotal).toBeNull();
    expect(after.marginPct).toBeNull();
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
