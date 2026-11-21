// Integration test for migration 0178_accountant_record_acceptance (S4-Q2): `quotation.record_acceptance` at `all`
// for the Accountant role, for a tenant that already holds role_permissions rows, as a `seeded` row written by
// system:migration-0178, with the authz version bumped once; a tenant still on the code defaults gets no row (a row
// there would strip every other role's defaults); an Accountant that already holds the permission keeps its own row
// and its tenant's version does not move.
// Migrates only through 0178, so a later grant migration cannot move the numbers this test reads.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/accountant-record-acceptance-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0178_accountant_record_acceptance';
const RECORD = 'quotation.record_acceptance';

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
let customised: TenantWithEntity;
let onDefaults: TenantWithEntity;
const versionsBefore = new Map<string, number>();

async function folderOf(name: string, entries: JournalEntry[], journal: object): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
  folders.push(folder);
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

async function seedRows(org: TenantWithEntity, rows: [string, string, string][]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'accountant-record-acceptance-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.organization_id', $2, true)`,
      [randomUUID(), org.organizationId],
    );
    for (const [roleKey, permission, scope] of rows) {
      await client.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, $2, $3, $4)',
        [org.tenantId, roleKey, permission, scope],
      );
    }
    await client.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 5)', [
      org.tenantId,
    ]);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function grants(org: TenantWithEntity, permission: string) {
  const { rows } = await pool.query<{ role_key: string; scope: string; seeded: boolean }>(
    `SELECT role_key, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = $2 ORDER BY role_key`,
    [org.tenantId, permission],
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

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  url = testDb.ownerUrl;
  pool = new Pool({ connectionString: url, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  await runMigrations(url, await folderOf('before-0178', journal.entries.slice(0, index), journal));

  running = await createTenantWithEntity(pool);
  await seedRows(running, [
    ['founder', 'memo.read', 'all'],
    ['accountant', 'quotation.read', 'all'],
    ['sales', RECORD, 'own'],
  ]);
  // A Founder already gave the Accountant the permission by hand, at `own`: nothing to add, no version bump.
  customised = await createTenantWithEntity(pool);
  await seedRows(customised, [
    ['accountant', RECORD, 'own'],
    ['sales', RECORD, 'own'],
  ]);
  onDefaults = await createTenantWithEntity(pool);
  for (const org of [running, customised]) versionsBefore.set(org.tenantId, (await version(org))!);

  through = await folderOf('through-0178', journal.entries.slice(0, index + 1), journal);
  await runMigrations(url, through);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0178 quotation.record_acceptance for the Accountant', () => {
  it('adds exactly one row, Accountant at all, seeded, and leaves the Sales row alone', async () => {
    expect(await grants(running, RECORD)).toEqual([
      { role_key: 'accountant', scope: 'all', seeded: true },
      { role_key: 'sales', scope: 'own', seeded: false },
    ]);
  });

  it('records the row as written by the migration and bumps the authz version once', async () => {
    const { rows } = await pool.query<{ actor_id: string; n: string }>(
      `SELECT actor_id, count(*) AS n FROM audit.audit_events
        WHERE tenant_id = $1 AND action = 'role_permissions.insert' AND after ->> 'permission' = $2
          AND actor_id LIKE 'system:%'
        GROUP BY actor_id`,
      [running.tenantId, RECORD],
    );
    expect(rows).toEqual([{ actor_id: 'system:migration-0178', n: '1' }]);
    expect(await version(running)).toBe(versionsBefore.get(running.tenantId)! + 1);
  });

  it("keeps an Accountant's own row and does not bump the version", async () => {
    expect(await grants(customised, RECORD)).toEqual([
      { role_key: 'accountant', scope: 'own', seeded: false },
      { role_key: 'sales', scope: 'own', seeded: false },
    ]);
    expect(await version(customised)).toBe(versionsBefore.get(customised.tenantId));
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
    expect(await grants(running, RECORD)).toHaveLength(2);
    expect(await version(running)).toBe(v);
  });
});
