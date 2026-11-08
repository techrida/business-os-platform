// Integration tests of DraftingService.create on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app (so every DB CHECK and trigger of 0016 runs), NumberingService,
// PricingService (NPR only: the MoneyService behind it is a stub that fails if FX is ever asked for) and the real
// AuditService. Faked: the request context, and authz.assert, which still runs the real pure can() on a fake
// principal, so the ResourceRef the service builds is what decides. The controller is another unit's, so the
// service is called directly; its exceptions carry the HTTP status.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/drafting.integration.test.ts
import 'reflect-metadata';

import {
  DEFAULT_ROLE_PERMISSIONS,
  QuotationDtoSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  createParty,
  quotationLines,
  quotations,
  quotationStatusHistory,
  quotationTaxSummary,
  quotationVersions,
  runMigrations,
} from '@bos/db';
import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  NotFoundException,
} from '@nestjs/common';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { asc, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import { systemActor, withTx, type TxScope } from '../../../platform/db/tx';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { PricingService } from '../pricing/pricing.service';
import { DraftingService, pricingInputOf } from './drafting.service';
import {
  GOLDEN_TOTALS,
  goldenCreateBody,
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
const current: { grants: Map<Permission, Scope> } = { grants: grantsOf('sales') };

const principalNow = (): Principal => ({
  userId: f.ownerUserId,
  zitadelUserId: `z-${f.ownerUserId}`,
  ...scopeA,
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
    scope: scopeA,
    actor: { kind: 'user' as const, id: f.ownerUserId, correlationId: 'test-corr' },
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
