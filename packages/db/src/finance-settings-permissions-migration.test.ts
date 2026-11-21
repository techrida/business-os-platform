// Integration test for migration 0120 (the finance settings permissions, K3): Finance gains settings.fx_rate.write and
// Finance and Accountant gain settings.finance.write, at scope all, in tenants that already hold role_permissions
// rows; a tenant on the code defaults, a row a Founder made and the level rows are left alone.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/finance-settings-permissions-migration.test.ts
//
// The database is migrated with the real SQL up to the migration before 0120, seeded, then migrated with the real
// runner through 0120 only, so a later grant migration cannot move the authz versions pinned here.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0120_finance_settings_permissions';
const SETTINGS_PERMISSIONS = ['settings.finance.write', 'settings.fx_rate.write'];

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let owner: Pool;
const folders: string[] = [];
let sql0120: string[];
let levelRowsBefore: unknown[];

/** Seeded grants, none of the settings permissions. */
let tenantA: TenantWithEntity;
/** A Founder already gave Finance exchange rates (department) and Accountant finance settings (own). */
let tenantB: TenantWithEntity;
/** Every role already holds what 0120 grants. */
let tenantHeld: TenantWithEntity;
/** No role_permissions rows: still on the code defaults. */
let tenantC: TenantWithEntity;

/** One transaction as bos_owner with the audit settings the triggers demand. */
async function writeAs<T>(
  org: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'finance-settings-migration-test', true),
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

/** Seeds role rows and, when given, the tenant's authz version. */
async function seedTenant(
  rows: readonly (readonly [role: string, permission: string, scope: string, seeded: boolean])[],
  version?: number,
): Promise<TenantWithEntity> {
  const org = await createTenantWithEntity(owner);
  await writeAs(org, async (c) => {
    for (const [role, permission, scope, seeded] of rows) {
      await c.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded) VALUES ($1, $2, $3, $4, $5)',
        [org.tenantId, role, permission, scope, seeded],
      );
    }
    if (version !== undefined) {
      await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, $2)', [
        org.tenantId,
        version,
      ]);
    }
  });
  return org;
}

/** `role permission scope seeded` for the settings permissions of one tenant, sorted. */
async function settingsGrantsOf(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    scope: string;
    seeded: boolean;
  }>(
    `SELECT role_key, permission, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = ANY($2::text[])`,
    [tenantId, SETTINGS_PERMISSIONS],
  );
  return rows.map((row) => `${row.role_key} ${row.permission} ${row.scope} ${row.seeded}`).sort();
}

async function authzVersion(tenantId: string): Promise<number | undefined> {
  const { rows } = await owner.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [tenantId],
  );
  return rows[0] === undefined ? undefined : Number(rows[0].version);
}

const levelRows = async (): Promise<unknown[]> =>
  (
    await owner.query<Record<string, unknown>>(
      'SELECT tenant_id, role_key, permission, min_level, scope, seeded FROM app.role_permission_levels ORDER BY 1, 2, 3, 4',
    )
  ).rows;

/** A migrations folder holding the journal's entries up to `end` (exclusive), as the real runner reads it. */
async function folderOf(
  journal: { entries: JournalEntry[] },
  end: number,
  name: string,
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
  folders.push(folder);
  await mkdir(join(folder, 'meta'));
  const entries = journal.entries.slice(0, end);
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  return folder;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  const ownerUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  const beforeFolder = await folderOf(journal, index, 'before-0120');
  const throughFolder = await folderOf(journal, index + 1, 'through-0120');
  sql0120 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenantA = await seedTenant(
    [
      ['founder', 'admin.settings.write', 'all', true],
      ['finance', 'quotation.read', 'all', true],
      ['accountant', 'crm.lead.read', 'own', true],
      ['sales', 'crm.lead.write', 'own', true],
    ],
    3,
  );
  await writeAs(tenantA, (c) =>
    c.query(
      `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope)
       VALUES ($1, 'sales', 'crm.lead.read', 'manager', 'department')`,
      [tenantA.tenantId],
    ),
  );
  tenantB = await seedTenant(
    [
      ['founder', 'admin.settings.write', 'all', true],
      ['finance', 'settings.fx_rate.write', 'department', false],
      ['accountant', 'settings.finance.write', 'own', false],
    ],
    1,
  );
  tenantHeld = await seedTenant(
    [
      ['finance', 'settings.fx_rate.write', 'all', true],
      ['finance', 'settings.finance.write', 'all', true],
      ['accountant', 'settings.finance.write', 'all', true],
      ['founder', 'settings.fx_rate.write', 'all', true],
      ['founder', 'settings.finance.write', 'all', true],
    ],
    5,
  );
  tenantC = await createTenantWithEntity(owner);
  levelRowsBefore = await levelRows();

  // The real runner now applies 0120 and nothing after it.
  await runMigrations(ownerUrl, throughFolder);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0120 finance settings permissions', () => {
  it('gives Finance exchange rates and finance settings, Accountant finance settings, and the Founder both, at scope all, seeded', async () => {
    expect(await settingsGrantsOf(tenantA.tenantId)).toEqual([
      'accountant settings.finance.write all true',
      'finance settings.finance.write all true',
      'finance settings.fx_rate.write all true',
      'founder settings.finance.write all true',
      'founder settings.fx_rate.write all true',
    ]);
  });

  it('keeps a row a Founder made, whatever its scope, and still adds the missing one', async () => {
    expect(await settingsGrantsOf(tenantB.tenantId)).toEqual([
      'accountant settings.finance.write own false',
      'finance settings.finance.write all true',
      'finance settings.fx_rate.write department false',
      'founder settings.finance.write all true',
      'founder settings.fx_rate.write all true',
    ]);
  });

  it('gives no other role a settings permission and leaves the other rows alone', async () => {
    const { rows } = await owner.query<{ role_key: string; permission: string; scope: string }>(
      `SELECT role_key, permission, scope FROM app.role_permissions
        WHERE tenant_id = $1 AND NOT (permission = ANY($2::text[])) ORDER BY 1, 2`,
      [tenantA.tenantId, SETTINGS_PERMISSIONS],
    );
    expect(rows).toEqual([
      { role_key: 'accountant', permission: 'crm.lead.read', scope: 'own' },
      { role_key: 'finance', permission: 'quotation.read', scope: 'all' },
      { role_key: 'founder', permission: 'admin.settings.write', scope: 'all' },
      { role_key: 'sales', permission: 'crm.lead.write', scope: 'own' },
    ]);
  });

  it('leaves a tenant with no role rows on the code defaults: no row, no version', async () => {
    const { rows } = await owner.query('SELECT 1 FROM app.role_permissions WHERE tenant_id = $1', [
      tenantC.tenantId,
    ]);
    expect(rows).toHaveLength(0);
    expect(await authzVersion(tenantC.tenantId)).toBeUndefined();
  });

  it('writes no level row', async () => {
    expect(await levelRows()).toEqual(levelRowsBefore);
  });

  it('bumps the authz version once for a tenant whose rows changed, and not for one that held them all', async () => {
    expect(await authzVersion(tenantA.tenantId)).toBe(4);
    expect(await authzVersion(tenantB.tenantId)).toBe(2);
    expect(await authzVersion(tenantHeld.tenantId)).toBe(5);
  });

  it('records the rows as the migration', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'role_permissions' AND actor_id = 'system:migration-0120'`,
      [tenantA.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(5);
  });

  it('changes nothing and bumps nothing when it runs again', async () => {
    const snapshot = async () => ({
      grants: (
        await owner.query(
          'SELECT tenant_id, role_key, permission, scope, seeded FROM app.role_permissions ORDER BY 1, 2, 3',
        )
      ).rows,
      levels: await levelRows(),
      versions: (await owner.query('SELECT tenant_id, version FROM app.authz_versions ORDER BY 1'))
        .rows,
    });
    const before = await snapshot();
    expect(sql0120).toHaveLength(3);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0120) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await snapshot()).toEqual(before);
  });
});
