// Integration test for migration 0155_sales_order_delivery_releases (F1-Q32, D56; R4c1 Q4).
//   * The grant: `sales_order.delivery_release` at `all` for Founder, Management and Finance of a tenant that
//     already holds role_permissions rows, as `seeded` rows written by system:migration-0155, with the authz
//     version bumped once; a tenant whose roles already hold it gets no duplicate row and no bump; a tenant still
//     on the code defaults gets no row (a row there would strip every other role's defaults). Re-running the
//     migrations changes nothing.
//   * The table: one release per order, a non-empty reason, and a release row is final (UPDATE and DELETE refused).
// Migrates only through 0155, so a later grant migration cannot move the numbers this test reads.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/sales-order-delivery-releases-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0155_sales_order_delivery_releases';
const PERMISSION = 'sales_order.delivery_release';
const ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
let url: string;
const folders: string[] = [];
let through: string;
let running: TenantWithEntity;
let holder: TenantWithEntity;
let onDefaults: TenantWithEntity;
const versionsBefore = new Map<string, number>();

/** Runs fn in one transaction with the audit actor and `org` as the acting entity; rolls back on a throw. */
async function inTx<T>(org: TenantWithEntity, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'delivery-release-migration-test', true),
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

async function seedRows(org: TenantWithEntity, rows: [string, string, string][]): Promise<void> {
  await inTx(org, async (client) => {
    for (const [roleKey, permission, scope] of rows) {
      await client.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, $2, $3, $4)',
        [org.tenantId, roleKey, permission, scope],
      );
    }
    await client.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 5)', [
      org.tenantId,
    ]);
  });
}

async function grants(org: TenantWithEntity) {
  const { rows } = await pool.query<{ role_key: string; scope: string; seeded: boolean }>(
    `SELECT role_key, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = $2 ORDER BY role_key`,
    [org.tenantId, PERMISSION],
  );
  return rows;
}

async function version(org: TenantWithEntity): Promise<number | undefined> {
  const { rows } = await pool.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [org.tenantId],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].version);
}

/** One statement in `org`'s entity; returns the first row's id when it has RETURNING id. */
async function exec(org: TenantWithEntity, text: string, params: unknown[] = []): Promise<string> {
  return inTx(org, async (c) => {
    const { rows } = await c.query<{ id?: string }>(text, params);
    return rows[0]?.id ?? '';
  });
}

/** A confirmed-shape sales order of `org`'s default entity (customer, deal, quotation and version behind it). */
async function salesOrder(org: TenantWithEntity): Promise<string> {
  const { partyId } = await createParty(pool, { tenantId: org.tenantId, kind: 'customer' });
  await exec(
    org,
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
    [partyId, org.tenantId, `CUS-${partyId.slice(0, 8)}`, ADDRESS],
  );
  const opportunityId = await exec(
    org,
    `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
     VALUES ($1, $2, $3, 'Acme website', $4) RETURNING id`,
    [org.tenantId, org.organizationId, `DEAL-${randomUUID().slice(0, 8)}`, partyId],
  );
  const quotationId = await exec(
    org,
    `INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [org.tenantId, org.organizationId, `QT-${randomUUID().slice(0, 8)}`, partyId, opportunityId],
  );
  const versionId = await exec(
    org,
    `INSERT INTO app.quotation_versions
       (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
     VALUES ($1, $2, $3, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
    [org.tenantId, org.organizationId, quotationId],
  );
  return exec(
    org,
    `INSERT INTO app.sales_orders
       (tenant_id, organization_id, customer_party_id, quotation_id, quotation_version_id, currency,
        subtotal, discount_amount, taxable_amount, tax_amount, total, fx_rate, amount_npr, credit_days)
     VALUES ($1, $2, $3, $4, $5, 'NPR', '100000.00', '0.00', '100000.00', '13000.00', '113000.00', 1,
             '113000.00', 30) RETURNING id`,
    [org.tenantId, org.organizationId, partyId, quotationId, versionId],
  );
}

const insertRelease = (org: TenantWithEntity, orderId: string, userId: string, reason: string) =>
  exec(
    org,
    `INSERT INTO app.sales_order_delivery_releases
       (tenant_id, organization_id, sales_order_id, released_by_user_id, reason, order_amount_npr, threshold_npr)
     VALUES ($1, $2, $3, $4, $5, '113000.00', '100000.00') RETURNING id`,
    [org.tenantId, org.organizationId, orderId, userId, reason],
  );

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  url = testDb.ownerUrl;
  pool = new Pool({ connectionString: url, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  /** A migrations folder holding the journal's first `end` entries. */
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
  await runMigrations(url, await folderOf('before-0155', index));
  through = await folderOf('through-0155', index + 1);

  running = await createTenantWithEntity(pool);
  await seedRows(running, [
    ['founder', 'memo.read', 'all'],
    ['management', 'memo.read', 'all'],
    ['finance', 'ar.read', 'all'],
    ['sales', 'quotation.read', 'own'],
  ]);
  holder = await createTenantWithEntity(pool);
  await seedRows(holder, [
    ['founder', PERMISSION, 'all'],
    ['management', PERMISSION, 'all'],
    ['finance', PERMISSION, 'all'],
  ]);
  onDefaults = await createTenantWithEntity(pool);
  for (const org of [running, holder]) versionsBefore.set(org.tenantId, (await version(org))!);

  await runMigrations(url, through);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0155 sales_order.delivery_release grant', () => {
  it('gives Founder, Management and Finance the permission at all, seeded, written by the migration', async () => {
    expect(await grants(running)).toEqual([
      { role_key: 'finance', scope: 'all', seeded: true },
      { role_key: 'founder', scope: 'all', seeded: true },
      { role_key: 'management', scope: 'all', seeded: true },
    ]);
    const { rows } = await pool.query<{ actor_id: string }>(
      `SELECT DISTINCT actor_id FROM audit.audit_events
        WHERE tenant_id = $1 AND action = 'role_permissions.insert' AND after ->> 'permission' = $2`,
      [running.tenantId, PERMISSION],
    );
    expect(rows).toEqual([{ actor_id: 'system:migration-0155' }]);
    expect(await version(running)).toBe(versionsBefore.get(running.tenantId)! + 1);
  });

  it('adds no duplicate row and leaves the version alone for a tenant whose roles already hold it', async () => {
    expect(await grants(holder)).toEqual([
      { role_key: 'finance', scope: 'all', seeded: false },
      { role_key: 'founder', scope: 'all', seeded: false },
      { role_key: 'management', scope: 'all', seeded: false },
    ]);
    expect(await version(holder)).toBe(versionsBefore.get(holder.tenantId));
  });

  it('writes nothing for a tenant still on the code defaults', async () => {
    const { rows } = await pool.query<{ n: string }>(
      'SELECT count(*) AS n FROM app.role_permissions WHERE tenant_id = $1',
      [onDefaults.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(0);
    expect(await version(onDefaults)).toBeUndefined();
  });

  it('is not re-applied by the runner', async () => {
    const v = await version(running);
    await runMigrations(url, through);
    expect(await grants(running)).toHaveLength(3);
    expect(await grants(holder)).toHaveLength(3);
    expect(await version(running)).toBe(v);
    expect(await version(holder)).toBe(versionsBefore.get(holder.tenantId));
  });
});

describe('0155 sales_order_delivery_releases table', () => {
  it('keeps one release per order with a non-empty reason, and refuses a change or removal of it', async () => {
    const orderId = await salesOrder(running);
    const { userId } = await createStaffUser(pool, running);

    await expect(insertRelease(running, orderId, userId, '   ')).rejects.toThrow(
      /sales_order_delivery_releases_reason_check/,
    );
    const releaseId = await insertRelease(running, orderId, userId, 'Customer collects today');
    expect(releaseId).not.toBe('');
    await expect(insertRelease(running, orderId, userId, 'Again')).rejects.toThrow(
      /sales_order_delivery_releases_order_unique/,
    );

    await expect(
      exec(
        running,
        `UPDATE app.sales_order_delivery_releases SET reason = 'edited' WHERE id = $1`,
        [releaseId],
      ),
    ).rejects.toThrow(/a delivery release is final/);
    await expect(
      exec(running, 'DELETE FROM app.sales_order_delivery_releases WHERE id = $1', [releaseId]),
    ).rejects.toThrow(/a delivery release is final/);

    const { rows } = await pool.query<{ reason: string }>(
      'SELECT reason FROM app.sales_order_delivery_releases WHERE sales_order_id = $1',
      [orderId],
    );
    expect(rows).toEqual([{ reason: 'Customer collects today' }]);
  });
});
