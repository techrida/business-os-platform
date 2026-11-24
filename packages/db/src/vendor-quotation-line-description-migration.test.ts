// Integration test for migration 0222 (R6Q23): a vendor quotation line carries its own description.
//   * every quotation line that exists before 0222 takes the description of its request line;
//   * the column is then NOT NULL with a non-blank CHECK;
//   * what it writes is audited as system:migration-0222, and a second run writes nothing.
// Migrates to just before 0222, seeds a request, RFQ and quotation with lines, then runs 0222 through the migrator
// and once more by hand. Needs Docker. Run with:
//   pnpm --filter @bos/db exec vitest run src/vendor-quotation-line-description-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createCostCenter,
  createDepartment,
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0222_vendor_quotation_line_description';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
let org: TenantWithEntity;
const folders: string[] = [];
let quotationId = '';
let prId = '';
const prLineIds: string[] = [];
let auditsAfterFirstRun = '';

async function inTx<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'vq-line-description-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.organization_id', $2, true)`,
      [randomUUID(), org.organizationId],
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const exec = (text: string, params: unknown[] = []) =>
  inTx(async (c) => (await c.query<{ id?: string }>(text, params)).rows[0]?.id ?? '');

const migrationAudits = async (): Promise<string> =>
  String(
    (
      await pool.query<{ n: string }>(
        `SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = 'system:migration-0222'`,
      )
    ).rows[0]?.n,
  );

async function runAgain(): Promise<void> {
  const statements = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // The column already exists and is NOT NULL: only the data statement is repeated.
    for (const statement of statements) {
      if (/^\s*UPDATE /m.test(statement) || /^\s*SELECT\s+set_config/m.test(statement)) {
        await client.query(statement);
      }
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

const lineDescriptions = async (): Promise<string[]> =>
  (
    await pool.query<{ description: string }>(
      `SELECT description FROM app.vendor_quotation_lines WHERE vendor_quotation_id = $1
        ORDER BY (SELECT line_no FROM app.purchase_request_lines p WHERE p.id = pr_line_id)`,
      [quotationId],
    )
  ).rows.map((r) => r.description);

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  const folderOf = async (name: string, end: number): Promise<string> => {
    const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
    folders.push(folder);
    await mkdir(join(folder, 'meta'));
    const entries = journal.entries.slice(0, end);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    return folder;
  };
  await runMigrations(testDb.ownerUrl, await folderOf('before-0222', index));

  org = await createTenantWithEntity(pool);
  const { tenantId, organizationId, idpOrgId } = org;
  const { userId } = await createStaffUser(pool, { tenantId, organizationId, idpOrgId });
  const { departmentId } = await createDepartment(pool, { tenantId, organizationId });
  const { costCenterId } = await createCostCenter(pool, { tenantId, organizationId });
  const taxCodeId = await exec(
    `INSERT INTO app.tax_codes (tenant_id, code, name, kind, rate_bp, creditable, effective_from)
     VALUES ($1, 'VAT13', 'VAT 13%', 'vat', 1300, true, '2024-01-01') RETURNING id`,
    [tenantId],
  );
  prId = await exec(
    `INSERT INTO app.purchase_requests
       (tenant_id, organization_id, number, request_type, department_id, requester_user_id, cost_center_id,
        justification, required_by, budget_code, currency)
     VALUES ($1, $2, $3, 'goods', $4, $5, $6, 'Replace switches', '2026-12-31', 'IT-2026', 'NPR') RETURNING id`,
    [tenantId, organizationId, `PR-${randomUUID()}`, departmentId, userId, costCenterId],
  );
  for (const [lineNo, description] of [
    [1, '24-port switch'],
    [2, 'Patch cables'],
  ] as const) {
    prLineIds.push(
      await exec(
        `INSERT INTO app.purchase_request_lines
           (tenant_id, organization_id, purchase_request_id, line_no, description, uom, quantity,
            estimated_unit_price, estimated_amount)
         VALUES ($1, $2, $3, $4, $5, 'pcs', 2, 1500.50, 3001.00) RETURNING id`,
        [tenantId, organizationId, prId, lineNo, description],
      ),
    );
  }
  const rfqId = await exec(
    `INSERT INTO app.rfqs (tenant_id, organization_id, purchase_request_id, number, deadline, created_by)
     VALUES ($1, $2, $3, $4, now() + interval '7 days', $5) RETURNING id`,
    [tenantId, organizationId, prId, `RFQ-${randomUUID()}`, userId],
  );
  const vendor = await createParty(pool, { tenantId, kind: 'vendor' });
  await exec(
    `INSERT INTO app.vendors (id, tenant_id, legal_name, kind, pan, country, created_by)
     VALUES ($1, $2, 'Himal Supplies Pvt. Ltd.', 'company', '123456789', 'NP', $3)`,
    [vendor.partyId, tenantId, userId],
  );
  await exec(
    `INSERT INTO app.vendor_accounts (tenant_id, organization_id, vendor_id, default_currency)
     VALUES ($1, $2, $3, 'NPR') RETURNING vendor_id AS id`,
    [tenantId, organizationId, vendor.partyId],
  );
  await exec(
    `INSERT INTO app.rfq_vendors (tenant_id, organization_id, rfq_id, vendor_id, invited_by)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [tenantId, organizationId, rfqId, vendor.partyId, userId],
  );
  const documentId = await exec(
    `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
     VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
    [tenantId, organizationId, randomUUID()],
  );
  quotationId = await exec(
    `INSERT INTO app.vendor_quotations
       (tenant_id, organization_id, rfq_id, purchase_request_id, vendor_id, valid_until, currency, subtotal,
        tax_amount, total, fx_rate, total_npr, document_id, recorded_by)
     VALUES ($1, $2, $3, $4, $5, '2026-12-31', 'NPR', 6002.00, 780.26, 6782.26, 1, 6782.26, $6, $7)
     RETURNING id`,
    [tenantId, organizationId, rfqId, prId, vendor.partyId, documentId, userId],
  );
  for (const prLineId of prLineIds) {
    await exec(
      `INSERT INTO app.vendor_quotation_lines
         (tenant_id, organization_id, vendor_quotation_id, purchase_request_id, pr_line_id, quantity, unit_price,
          tax_code_id, gross, tax_amount, line_total)
       VALUES ($1, $2, $3, $4, $5, 2, 1500.50, $6, 3001.00, 390.13, 3391.13) RETURNING id`,
      [tenantId, organizationId, quotationId, prId, prLineId, taxCodeId],
    );
  }

  await runMigrations(testDb.ownerUrl, await folderOf('through-0222', index + 1));
  auditsAfterFirstRun = await migrationAudits();
}, 240_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  await Promise.all(folders.map((folder) => rm(folder, { recursive: true, force: true })));
});

describe('0222 vendor quotation line description', () => {
  it('gives every existing line the description of its request line', async () => {
    expect(await lineDescriptions()).toEqual(['24-port switch', 'Patch cables']);
  });

  it('makes the column NOT NULL and refuses a blank description (23514)', async () => {
    const insertLine = (description: string | null) =>
      exec(
        `INSERT INTO app.vendor_quotation_lines
           (tenant_id, organization_id, vendor_quotation_id, purchase_request_id, pr_line_id, description,
            quantity, unit_price, tax_code_id, gross, tax_amount, line_total)
         SELECT tenant_id, organization_id, vendor_quotation_id, purchase_request_id, $1::uuid, $2, quantity,
                unit_price, tax_code_id, gross, tax_amount, line_total
           FROM app.vendor_quotation_lines WHERE vendor_quotation_id = $3 LIMIT 1 RETURNING id`,
        [randomUUID(), description, quotationId],
      );
    await expect(insertLine(null)).rejects.toMatchObject({ code: '23502' });
    await expect(insertLine('   ')).rejects.toMatchObject({
      code: '23514',
      constraint: 'vendor_quotation_lines_description_check',
    });
  });

  it('audits what it wrote as system:migration-0222 and writes nothing a second time', async () => {
    expect(Number(auditsAfterFirstRun)).toBeGreaterThanOrEqual(2);
    await runAgain();
    expect(await migrationAudits()).toBe(auditsAfterFirstRun);
  });
});
