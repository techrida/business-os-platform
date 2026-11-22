// Integration tests of the quotation preview on a real Postgres (Testcontainers, needs Docker in WSL).
// Real: migrations as bos_owner, queries as bos_app, the controller behind the production body parser and error
// filter, QuotationPreviewService, the real PricingService (tax codes and MoneyService read from the database) and
// the real ApprovalsService with a quotation_version workflow published through ApprovalsAdminService. Faked: audit,
// notify, the user directory, the request context, and authz.assert (which still runs the real pure can() on a fake
// principal, so the ResourceRef the service builds is what decides 403 or 404). Every success is parsed with the
// PreviewResultSchema the workspace uses.
// The workflow below is the one this route needs published in a tenant (the seed rows in the hand-back are the same):
// base route accountant then finance, management above 1,00,000 NPR or a discount above 12%, founder above 10,00,000.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/preview/quotation-preview.integration.test.ts
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  DEFAULT_ROLE_PERMISSIONS,
  ErrorBodySchema,
  PreviewResultSchema,
  type Permission,
  type PreviewResult,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import {
  approvalRequests,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  quotationLines,
  quotationVersions,
  users,
} from '@bos/db';
import { ForbiddenException, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { configureApp } from '../../../app.setup';
import type { AuthzService } from '../../../platform/authz/authz.service';
import { can } from '../../../platform/authz/can';
import type { Principal } from '../../../platform/authz/principal';
import type { Db } from '../../../platform/db/db.module';
import { systemActor, withTx } from '../../../platform/db/tx';
import { MoneyService } from '../../../platform/settings/money.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { ErrorBodyFilter } from '../../../platform/tenancy/error-body.filter';
import { ApprovalsAdminService } from '../../approvals/admin.service';
import { asSecondPerson, SKIP_LIVE_PUBLISHER_CHECK } from '../../../../test/support/second-person';
import { ApprovalsService } from '../../approvals/requests.service';
import { PricingService } from '../pricing/pricing.service';
import { QuotationPreviewController } from './quotation-preview.controller';
import { QuotationPreviewService } from './quotation-preview.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const ADDRESS = { line: '1 Durbar Marg', city: 'Kathmandu' };

// The quotation_version workflow, written the way the seed writes it. One management step serves both rules: a
// workflow may not repeat a step id, and distinctApprovers would otherwise need two management people.
const seedSpec = {
  documentType: 'quotation_version',
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: 'Base route: accountant checks the quotation',
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [
    {
      id: 'management',
      when: {
        any: [
          { field: 'amountNpr', op: 'gt', value: '100000' },
          { field: 'effectiveDiscountPct', op: 'gt', value: '12' },
        ],
      },
      add: { id: 'management', kind: 'role', role: 'management', reason: 'Management approval' },
      position: 'end',
      reason: 'Management approval: above 1,00,000 NPR or a discount above 12%',
    },
    {
      id: 'over-10-lakh',
      when: { field: 'amountNpr', op: 'gt', value: '1000000' },
      add: { id: 'founder', kind: 'role', role: 'founder', reason: 'Founder approval' },
      position: 'end',
      reason: 'Founder approval because the NPR amount exceeds 10,00,000',
    },
  ],
};

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;
let app: INestApplication;
let baseUrl: string;
let tenantId: string;
/** Entity A is the acting entity of the requests below; entity B is another legal entity of the tenant. */
let scopeA: { tenantId: string; organizationId: string };
let scopeB: { tenantId: string; organizationId: string };
let acting: { tenantId: string; organizationId: string };
let staffIdpOrgId: string;
let customerA: string;
let vatId: string;
const now = new Date('2026-11-09T04:00:00Z');

const U: Record<'salesA' | 'salesB' | 'boss' | 'acc' | 'fin' | 'mgmt' | 'founder', string> = {
  salesA: randomUUID(),
  salesB: randomUUID(),
  boss: randomUUID(),
  acc: randomUUID(),
  fin: randomUUID(),
  mgmt: randomUUID(),
  founder: randomUUID(),
};
const roles: Partial<Record<RoleKey, string[]>> = {};
const resetRoles = () => {
  roles.accountant = [U.acc];
  roles.finance = [U.fin];
  roles.management = [U.mgmt];
  roles.founder = [U.founder];
};

const grantsOf = (role: RoleKey) =>
  new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS[role])) as Map<Permission, Scope>;
const current: { userId: string; grants: Map<Permission, Scope> } = {
  userId: U.salesA,
  grants: grantsOf('sales'),
};
const as = (userId: string, role: RoleKey) => {
  current.userId = userId;
  current.grants = grantsOf(role);
};

const principalNow = (): Principal => ({
  userId: current.userId,
  zitadelUserId: `z-${current.userId}`,
  ...acting,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: staffIdpOrgId,
  roles: [],
  departmentId: null,
  status: 'active',
  grants: current.grants,
});
const caller = {
  current: () => ({
    scope: acting,
    actor: { kind: 'user' as const, id: current.userId, correlationId: 'test-corr' },
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
const audit = { record: vi.fn(() => Promise.resolve(undefined)) };
const notify = {
  notifyUser: vi.fn(() => Promise.resolve(undefined)),
  notifyRole: vi.fn(() => Promise.resolve(undefined)),
  nudge: vi.fn(() => Promise.resolve(undefined)),
};
const directory = {
  userIdsWithRole: vi.fn((_s: unknown, role: RoleKey) => Promise.resolve(roles[role] ?? [])),
  resolve: vi.fn(),
  emailOf: vi.fn(),
};

beforeAll(async () => {
  testDb = await createTestDatabase();
  const admin0 = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin0.end();
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 8 });
  db = drizzle({ client: appPool });

  const tenant = await createTenantWithEntity(appPool);
  tenantId = tenant.tenantId;
  staffIdpOrgId = tenant.idpOrgId;
  scopeA = { tenantId, organizationId: tenant.organizationId };
  const entityB = randomUUID();
  // The audit trigger refuses a write without bos.actor_id, so the second entity goes through withTx.
  await withTx(db, scopeA, systemActor('test'), (tx) =>
    tx.execute(
      sql`INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
          VALUES (${entityB}, ${tenantId}, ${entityB}, ${`E-${entityB}`}, ${`E-${entityB}`}, ${`E-${entityB}`}, false)`,
    ),
  );
  scopeB = { tenantId, organizationId: entityB };
  acting = scopeA;

  for (const key of ['salesA', 'salesB', 'boss', 'acc'] as const) {
    U[key] = (await createStaffUser(appPool, { ...scopeA, idpOrgId: tenant.idpOrgId })).userId;
  }
  const { partyId } = await createParty(appPool, { tenantId, kind: 'customer' });
  customerA = partyId;
  await withTx(db, scopeA, systemActor('test'), async (tx) => {
    await tx.update(users).set({ displayName: 'Sita Sharma' }).where(eq(users.id, U.acc));
    await tx.execute(
      sql`INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address_line, address_city)
          VALUES (${customerA}, ${tenantId}, ${`CUS-${customerA.slice(0, 8)}`}, 'Acme Pvt. Ltd.', 'acme', ${ADDRESS.line}, ${ADDRESS.city})`,
    );
    const code = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
          VALUES (${tenantId}, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2020-01-01') RETURNING id`,
    );
    vatId = code.rows[0]!.id;
  });

  // The published workflow, entered as the founder would.
  resetRoles();
  as(U.boss, 'founder');
  const adminSvc = new ApprovalsAdminService(db, audit, caller, () => now);
  const adminSvcPublisher = new ApprovalsAdminService(db, audit, asSecondPerson(caller), () => now);
  await adminSvc.createWorkflow({
    key: 'quotation_version',
    name: 'Quotation',
    spec: seedSpec,
  });
  await adminSvcPublisher.publish('quotation_version', 1, SKIP_LIVE_PUBLISHER_CHECK);

  const approvals = new ApprovalsService(db, audit, notify, directory, caller, () => now);
  const pricing = new PricingService(new MoneyService(db, new SettingsService(db)));
  const service = new QuotationPreviewService(
    db,
    authz as unknown as AuthzService,
    pricing,
    approvals,
    caller,
  );
  const moduleRef = await Test.createTestingModule({
    controllers: [QuotationPreviewController],
    providers: [{ provide: QuotationPreviewService, useValue: service }],
  }).compile();
  app = moduleRef.createNestApplication({ rawBody: true, logger: false });
  configureApp(app);
  app.useGlobalFilters(new ErrorBodyFilter());
  await app.listen(0, '127.0.0.1');
  baseUrl = `http://127.0.0.1:${((app.getHttpServer() as Server).address() as AddressInfo).port}`;
});

afterAll(async () => {
  await app?.close();
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  vi.clearAllMocks();
  resetRoles();
  acting = scopeA;
  as(U.salesA, 'sales');
});

// ---------------------------------------------------------------------------------------- helpers

/** A quotation of entity A owned by `owner`, with one Draft version (NPR, issue date 2026-11-09). */
async function seedDraft(
  owner: string = U.salesA,
): Promise<{ quotationId: string; versionId: string }> {
  return withTx(db, scopeA, systemActor('test'), async (tx) => {
    const opportunity = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
          VALUES (${tenantId}, ${scopeA.organizationId}, ${`DEAL-${randomUUID().slice(0, 8)}`}, 'Acme website', ${customerA})
          RETURNING id`,
    );
    const quotation = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id, owner_user_id)
          VALUES (${tenantId}, ${scopeA.organizationId}, ${`QT-${randomUUID().slice(0, 8)}`}, ${customerA},
                  ${opportunity.rows[0]!.id}, ${owner})
          RETURNING id`,
    );
    const version = await tx.execute<{ id: string }>(
      sql`INSERT INTO app.quotation_versions
            (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
          VALUES (${tenantId}, ${scopeA.organizationId}, ${quotation.rows[0]!.id}, 1, 'NPR',
                  '2026-11-09', '2026-12-09')
          RETURNING id`,
    );
    return { quotationId: quotation.rows[0]!.id, versionId: version.rows[0]!.id };
  });
}

/** The body the workspace sends: currency, lines and, only when there is one, the discount. */
const bodyOf = (unitPrice: string, discount?: { mode: 'pct'; value: string }) => ({
  currency: 'NPR',
  ...(discount === undefined ? {} : { discount }),
  lines: [
    { description: 'Implementation', uom: 'job', quantity: '1', unitPrice, taxCodeId: vatId },
  ],
});

const post = (quotationId: string, versionId: string, body: unknown) =>
  request(baseUrl)
    .post(`/v1/quotations/${quotationId}/versions/${versionId}/preview`)
    .send(body as object);

const stepRoles = (result: PreviewResult) => result.route.steps.map((s) => s.roleKey);

// ------------------------------------------------------------------------------------------------ tests

describe('POST /v1/quotations/:id/versions/:vid/preview', () => {
  it('routes an NPR 15,00,000 quote through accountant, finance, management and the founder', async () => {
    const { quotationId, versionId } = await seedDraft();
    const res = await post(quotationId, versionId, bodyOf('1500000.00'));
    expect(res.status).toBe(200);
    const result = PreviewResultSchema.parse(res.body);
    // 15,00,000 + 13% VAT = 16,95,000, above both the 1 lakh and the 10 lakh bands (amountNpr is the total).
    expect(result.totals).toMatchObject({
      subtotal: '1500000.00',
      taxAmount: '195000.00',
      total: '1695000.00',
    });
    expect(result.nprSnapshot).toBeNull();
    expect(stepRoles(result)).toEqual(['accountant', 'finance', 'management', 'founder']);
    expect(result.route.blocked).toBe(false);
    // A requester sees the steps, not the people.
    expect(result.route.steps.every((s) => s.eligibleUserIds.length === 0)).toBe(true);
    expect(result.route.steps.every((s) => (s.eligibleStaffNames ?? []).length === 0)).toBe(true);
    // Except for the one choice they make (demo 2026-11-17): who decides the first step of THIS quote. Only that
    // step's people are offered, by name and id (the select's value); the later steps' people stay hidden.
    expect(result.approverChoice).toEqual({
      seq: 1,
      options: [
        {
          userId: U.acc,
          name: 'Sita Sharma',
          roleKey: 'accountant',
          hasEmail: expect.any(Boolean) as unknown,
        },
      ],
    });
  });

  it('shows eligible staff names to an approver without returning their identifiers', async () => {
    const { quotationId, versionId } = await seedDraft();
    as(U.boss, 'founder');
    const res = await post(quotationId, versionId, bodyOf('50000.00'));
    expect(res.status).toBe(200);
    const result = PreviewResultSchema.parse(res.body);
    expect(result.route.steps[0]).toMatchObject({
      roleKey: 'accountant',
      eligibleStaffNames: ['Sita Sharma'],
      eligibleUserIds: [],
    });
    // The route itself carries no identifiers; only the first-step choice does.
    expect(JSON.stringify(result.route)).not.toContain(U.acc);
    expect(result.approverChoice?.options.map((o) => o.userId)).toEqual([U.acc]);
  });

  it('adds management, and only management, for a 13% discount on a quote under 1 lakh', async () => {
    const { quotationId, versionId } = await seedDraft();
    const res = await post(
      quotationId,
      versionId,
      bodyOf('50000.00', { mode: 'pct', value: '13' }),
    );
    expect(res.status).toBe(200);
    const result = PreviewResultSchema.parse(res.body);
    expect(result.totals.effectiveDiscountPct).toBe('13.0000');
    expect(stepRoles(result)).toEqual(['accountant', 'finance', 'management']);
    expect(result.route.steps[2]!.reason).toContain('discount above 12%');
  });

  it('adds no management step for a discount of exactly 12% (strictly above) or a small quote', async () => {
    const { quotationId, versionId } = await seedDraft();
    const exact = await post(
      quotationId,
      versionId,
      bodyOf('50000.00', { mode: 'pct', value: '12' }),
    );
    expect(stepRoles(PreviewResultSchema.parse(exact.body))).toEqual(['accountant', 'finance']);
    const none = await post(quotationId, versionId, bodyOf('50000.00'));
    expect(stepRoles(PreviewResultSchema.parse(none.body))).toEqual(['accountant', 'finance']);
  });

  it('treats a body without a discount as no discount, whatever discount the saved draft holds', async () => {
    const { quotationId, versionId } = await seedDraft();
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions SET discount_mode = 'pct', discount_input = 13 WHERE id = ${versionId}`,
      ),
    );
    const res = await post(quotationId, versionId, bodyOf('50000.00'));
    const result = PreviewResultSchema.parse(res.body);
    expect(result.totals.discountAmount).toBe('0.00');
    expect(stepRoles(result)).toEqual(['accountant', 'finance']);
  });

  it('writes nothing: no version, line or approval request changes', async () => {
    const { quotationId, versionId } = await seedDraft();
    const snapshot = async () => {
      const [v] = await db
        .select()
        .from(quotationVersions)
        .where(eq(quotationVersions.id, versionId));
      const lines = await db
        .select()
        .from(quotationLines)
        .where(eq(quotationLines.versionId, versionId));
      const requests = await db.select().from(approvalRequests);
      return { v, lines: lines.length, requests: requests.length };
    };
    const before = await snapshot();
    const res = await post(quotationId, versionId, bodyOf('1500000.00'));
    expect(res.status).toBe(200);
    expect(await snapshot()).toEqual(before);
  });

  it('answers 404 for a quotation of another entity', async () => {
    const { quotationId, versionId } = await seedDraft();
    acting = scopeB;
    const res = await post(quotationId, versionId, bodyOf('50000.00'));
    expect(res.status).toBe(404);
    expect(ErrorBodySchema.parse(res.body).error.code).toBe('not_found');
  });

  it('answers 404 for another sales user draft (own scope), and 200 for a founder', async () => {
    const { quotationId, versionId } = await seedDraft(U.salesA);
    as(U.salesB, 'sales');
    expect((await post(quotationId, versionId, bodyOf('50000.00'))).status).toBe(404);
    as(U.boss, 'founder');
    expect((await post(quotationId, versionId, bodyOf('50000.00'))).status).toBe(200);
  });

  it('answers 404 when the version is not a version of that quotation', async () => {
    const one = await seedDraft();
    const two = await seedDraft();
    expect((await post(one.quotationId, two.versionId, bodyOf('50000.00'))).status).toBe(404);
    expect((await post(randomUUID(), one.versionId, bodyOf('50000.00'))).status).toBe(404);
  });

  it('answers 409 for a version that is no longer a draft or returned', async () => {
    const { quotationId, versionId } = await seedDraft();
    await withTx(db, scopeA, systemActor('test'), (tx) =>
      tx.execute(
        sql`UPDATE app.quotation_versions
               SET status = 'submitted', submitted_at = now(), fx_rate = 1, amount_npr = total,
                   npr_taxable_amount = taxable_amount, content_sha256 = decode(repeat('ab', 32), 'hex'),
                   snapshot_sha256 = decode(repeat('ab', 32), 'hex')
             WHERE id = ${versionId}`,
      ),
    );
    const res = await post(quotationId, versionId, bodyOf('50000.00'));
    expect(res.status).toBe(409);
  });

  it('answers 400 for an unknown tax code and for a body the contract refuses', async () => {
    const { quotationId, versionId } = await seedDraft();
    const unknown = bodyOf('50000.00');
    unknown.lines[0]!.taxCodeId = randomUUID();
    expect((await post(quotationId, versionId, unknown)).status).toBe(400);
    expect((await post(quotationId, versionId, { currency: 'NPR', lines: [] })).status).toBe(400);
  });
});
