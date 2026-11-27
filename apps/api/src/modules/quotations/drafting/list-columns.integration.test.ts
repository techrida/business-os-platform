// Integration test (real Postgres, needs Docker): the quotation reads leave the document style in the database
// (round 7, unit U1-08). A sent quotation's `document_style` holds the company profile and can hold a logo of tens of
// kilobytes; the list shows four figures of the current version and no DTO of this module reads the style, so no read
// may select it. A drizzle logger captures the SQL of each read.
// Run: pnpm --filter @bos/api exec vitest run src/modules/quotations/drafting/list-columns.integration.test.ts
import 'reflect-metadata';

import {
  DEFAULT_ROLE_PERMISSIONS,
  QuotationListItemSchema,
  type Permission,
  type RoleKey,
  type Scope,
} from '@bos/contracts';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../../../platform/audit/audit.service';
import type { AuthzService } from '../../../platform/authz/authz.service';
import type { Principal } from '../../../platform/authz/principal';
import type { TxScope } from '../../../platform/db/tx';
import { CurrencyEnabledService } from '../../../platform/settings/currency-enabled';
import type { MoneyService } from '../../../platform/settings/money.service';
import { NumberingService } from '../../../platform/settings/numbering.service';
import { SettingsService } from '../../../platform/settings/settings.service';
import { PricingService } from '../pricing/pricing.service';
import { DraftingService } from './drafting.service';
import {
  goldenCreateBody,
  seedQuotationFixture,
  type QuotationFixture,
  type QuotationFixtureDb,
} from './quotation.fixture';

vi.setConfig({ testTimeout: 60_000, hookTimeout: 180_000 });

const LOGO_BYTES = 50 * 1024;

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let f: QuotationFixture;
let scope: TxScope;
let service: DraftingService;
let quotationId = '';
const statements: string[] = [];

const principal = (): Principal => ({
  userId: f.ownerUserId,
  zitadelUserId: `z-${f.ownerUserId}`,
  ...scope,
  orgKind: 'staff',
  partyId: null,
  idpOrgId: 'unused',
  roles: [],
  departmentId: null,
  status: 'active',
  grants: new Map(Object.entries(DEFAULT_ROLE_PERMISSIONS['sales' as RoleKey])) as Map<
    Permission,
    Scope
  >,
});
const caller = {
  current: () => ({
    scope,
    actor: { kind: 'user' as const, id: f.ownerUserId, correlationId: 'test-corr' },
    principal: principal(),
  }),
};
const money = {
  toNprSnapshot: () => Promise.reject(new Error('MoneyService is not used for NPR quotations')),
} as unknown as MoneyService;

/** The SQL the service sent while `fn` ran. */
async function capture(fn: () => Promise<unknown>): Promise<string[]> {
  statements.length = 0;
  await fn();
  return [...statements];
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  const db = drizzle({ client: appPool }) as QuotationFixtureDb;
  const countingDb = drizzle({
    client: appPool,
    logger: { logQuery: (query: string) => void statements.push(query) },
  });

  f = await seedQuotationFixture(db);
  scope = { tenantId: f.tenantId, organizationId: f.entityId };
  const deps = [
    new NumberingService(),
    new PricingService(money),
    { assert: () => undefined } as unknown as AuthzService,
  ] as const;
  const build = (database: typeof db | typeof countingDb) =>
    new DraftingService(
      database,
      ...deps,
      new AuditService(database),
      caller,
      new CurrencyEnabledService(new SettingsService(database)),
    );
  const creator = build(db);
  service = build(countingDb);
  quotationId = (await creator.create(goldenCreateBody(f), 'list-columns-create')).id;

  // The render job captures the style after approval; the guard trigger refuses it on a draft, so seed it with
  // triggers off (a superuser connection, the replica role), the way a rendered quotation looks.
  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  const client = await admin.connect();
  try {
    await client.query("SET session_replication_role = 'replica'");
    await client.query(
      `UPDATE app.quotation_versions SET document_style = jsonb_build_object('logo', repeat('x', ${LOGO_BYTES}))
       WHERE quotation_id = $1`,
      [quotationId],
    );
  } finally {
    client.release();
    await admin.end();
  }
});

afterAll(async () => {
  await appPool?.end();
  await ownerPool?.end();
  await testDb?.drop();
});

describe('quotation reads leave document_style in the database', () => {
  it('the fixture really holds a logo-sized style', async () => {
    const { rows } = await ownerPool.query<{ size: number }>(
      'SELECT octet_length(document_style::text) AS size FROM app.quotation_versions WHERE quotation_id = $1',
      [quotationId],
    );
    expect(rows[0]!.size).toBeGreaterThan(LOGO_BYTES);
  });

  it('the list selects four columns of the version and not the style, and answers as before', async () => {
    let page: Awaited<ReturnType<DraftingService['list']>> | undefined;
    const sent = await capture(async () => {
      page = await service.list({ limit: 25 });
    });
    const read = sent.filter((s) => s.includes('from "app"."quotations"'));
    expect(read.length).toBeGreaterThan(0);
    for (const s of sent) expect(s).not.toContain('document_style');
    expect(page!.total).toBe(1);
    const item = QuotationListItemSchema.parse(page!.rows[0]);
    expect(item).toMatchObject({ id: quotationId, status: 'draft', currency: 'NPR' });
    expect(Number(item.total)).toBeGreaterThan(0);
  });

  it('detail and one version leave the style out too, and still answer', async () => {
    const detail = await service.detail(quotationId);
    const versionId = detail.versions[0]!.id;
    const sent = await capture(async () => {
      await service.detail(quotationId);
      await service.getVersion(quotationId, versionId);
    });
    for (const s of sent) expect(s).not.toContain('document_style');
    expect(detail.versions).toHaveLength(1);
    // The style is still stored: only the reads skip it.
    const { rowCount } = await appPool.query(
      'SELECT 1 FROM app.quotation_versions WHERE id = $1 AND document_style IS NOT NULL',
      [versionId],
    );
    expect(rowCount).toBe(1);
  });
});
