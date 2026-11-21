// Integration test for migration 0121 (the lead and opportunity reopen permissions, K2): the Founder gets both at scope
// all, and every other role that writes leads or opportunities gets the matching reopen permission at scope
// department, in tenants that already hold role_permissions rows; a tenant on the code defaults, a row a Founder
// made and the level rows are left alone.
// Needs Docker: a database of its own in the run's shared postgres:16-alpine container (no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/crm-reopen-permissions-migration.test.ts
//
// The database is migrated with the real SQL up to the migration before 0121, seeded, then migrated with the real
// runner through 0121 only, so a later grant migration cannot move the authz versions pinned here.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0121_crm_reopen_permissions';
const REOPEN_PERMISSIONS = ['crm.lead.reopen', 'crm.opportunity.reopen'];

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let owner: Pool;
const folders: string[] = [];
let sql0121: string[];
let levelRowsBefore: unknown[];

/** Seeded writers of leads and opportunities, and a Founder that holds lead write itself. */
let tenantA: TenantWithEntity;
/** A Founder already narrowed Sales' lead reopen to its own and made its own lead reopen row. */
let tenantB: TenantWithEntity;
/** Every role already holds what 0121 grants. */
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
              set_config('bos.actor_id', 'crm-reopen-migration-test', true),
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

/** `role permission scope seeded` for the reopen permissions of one tenant, sorted. */
async function reopenGrantsOf(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    scope: string;
    seeded: boolean;
  }>(
    `SELECT role_key, permission, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = ANY($2::text[])`,
    [tenantId, REOPEN_PERMISSIONS],
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
  const beforeFolder = await folderOf(journal, index, 'before-0121');
  const throughFolder = await folderOf(journal, index + 1, 'through-0121');
  sql0121 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  // Sales writes its own leads and opportunities, Marketing and Finance only leads, a Founder let Operations Head
  // edit every opportunity, and PMO only reads leads.
  tenantA = await seedTenant(
    [
      ['founder', 'crm.lead.write', 'all', true],
      ['founder', 'crm.opportunity.write', 'all', true],
      ['sales', 'crm.lead.write', 'own', true],
      ['sales', 'crm.opportunity.write', 'own', true],
      ['marketing', 'crm.lead.write', 'own', true],
      ['finance', 'crm.lead.write', 'own', true],
      ['operations_head', 'crm.opportunity.write', 'all', false],
      ['pmo', 'crm.lead.read', 'own', true],
    ],
    3,
  );
  await writeAs(tenantA, (c) =>
    c.query(
      `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope)
       VALUES ($1, 'sales', 'crm.lead.write', 'manager', 'department')`,
      [tenantA.tenantId],
    ),
  );
  tenantB = await seedTenant(
    [
      ['founder', 'crm.lead.reopen', 'all', false],
      ['sales', 'crm.lead.write', 'own', true],
      ['sales', 'crm.lead.reopen', 'own', false],
    ],
    1,
  );
  tenantHeld = await seedTenant(
    [
      ['founder', 'crm.lead.reopen', 'all', true],
      ['founder', 'crm.opportunity.reopen', 'all', true],
      ['sales', 'crm.lead.write', 'own', true],
      ['sales', 'crm.lead.reopen', 'department', true],
    ],
    5,
  );
  tenantC = await createTenantWithEntity(owner);
  levelRowsBefore = await levelRows();

  // The real runner now applies 0121 and nothing after it.
  await runMigrations(ownerUrl, throughFolder);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0121 reopen permissions', () => {
  it('gives the Founder both at scope all, even where it writes leads, and each writer its reopen at department', async () => {
    expect(await reopenGrantsOf(tenantA.tenantId)).toEqual([
      'finance crm.lead.reopen department true',
      'founder crm.lead.reopen all true',
      'founder crm.opportunity.reopen all true',
      'marketing crm.lead.reopen department true',
      'operations_head crm.opportunity.reopen department true',
      'sales crm.lead.reopen department true',
      'sales crm.opportunity.reopen department true',
    ]);
  });

  it('gives a role that only reads leads no reopen permission', async () => {
    const { rows } = await owner.query(
      `SELECT permission FROM app.role_permissions
        WHERE tenant_id = $1 AND role_key = 'pmo' ORDER BY 1`,
      [tenantA.tenantId],
    );
    expect(rows).toEqual([{ permission: 'crm.lead.read' }]);
  });

  it('keeps a reopen row a Founder made, whatever its scope, and still adds the missing one', async () => {
    expect(await reopenGrantsOf(tenantB.tenantId)).toEqual([
      'founder crm.lead.reopen all false',
      'founder crm.opportunity.reopen all true',
      'sales crm.lead.reopen own false',
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
        WHERE tenant_id = $1 AND entity_type = 'role_permissions' AND actor_id = 'system:migration-0121'`,
      [tenantA.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(7);
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
    expect(sql0121).toHaveLength(3);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0121) await client.query(statement);
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
