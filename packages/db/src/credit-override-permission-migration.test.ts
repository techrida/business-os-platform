// Integration test for migration 0104_credit_override_permission (F1-Q20, F1-Q26): `credit.override` at `all` for the
// Founder, Management and Finance roles of a tenant that already holds role_permissions rows, as `seeded` rows written by
// system:migration-0104, with the authz version bumped once; a tenant still on the code defaults gets no row (a row
// there would strip every other role's defaults); a role that already holds the permission keeps its own row.
// Migrates only through 0104, so a later migration that grants something else (and bumps the version again, like
// 0155) cannot move the numbers this test reads.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/credit-override-permission-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0104_credit_override_permission';
const PERMISSION = 'credit.override';

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

async function seedRows(org: TenantWithEntity, rows: [string, string, string][]): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'credit-override-migration-test', true),
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
  await runMigrations(url, await folderOf('before-0104', index));
  through = await folderOf('through-0104', index + 1);

  running = await createTenantWithEntity(pool);
  await seedRows(running, [
    ['founder', 'memo.read', 'all'],
    ['management', 'memo.read', 'all'],
    ['finance', 'ar.read', 'all'],
    ['sales', 'quotation.read', 'own'],
  ]);
  customised = await createTenantWithEntity(pool);
  await seedRows(customised, [
    ['finance', PERMISSION, 'all'],
    ['management', 'memo.read', 'all'],
  ]);
  onDefaults = await createTenantWithEntity(pool);
  for (const org of [running, customised]) versionsBefore.set(org.tenantId, (await version(org))!);

  await runMigrations(url, through);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0104 credit.override', () => {
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
    expect(rows).toEqual([{ actor_id: 'system:migration-0104' }]);
    expect(await version(running)).toBe(versionsBefore.get(running.tenantId)! + 1);
  });

  it("keeps a role's own row and adds only the missing role", async () => {
    expect(await grants(customised)).toEqual([
      { role_key: 'finance', scope: 'all', seeded: false },
      { role_key: 'founder', scope: 'all', seeded: true },
      { role_key: 'management', scope: 'all', seeded: true },
    ]);
    expect(await version(customised)).toBe(versionsBefore.get(customised.tenantId)! + 1);
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
    expect(await version(running)).toBe(v);
  });
});
