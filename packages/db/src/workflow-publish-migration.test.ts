// Integration test for migration 0127 (publishing a workflow needs a second person, F1-Q11): workflow_versions gains
// created_by; Management gains approvals.definitions.read and .publish and the Founder .publish, at scope all, in
// tenants that already hold role_permissions rows; a tenant on the code defaults and a row a Founder made are left alone.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/workflow-publish-migration.test.ts
//
// The database is migrated with the real SQL up to the migration before 0127, seeded, then migrated with the real
// runner through 0127 only, so a later grant migration cannot move the authz versions pinned here.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity, type TenantWithEntity } from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const TAG = '0127_workflow_publish';
const PUBLISH_PERMISSIONS = ['approvals.definitions.read', 'approvals.definitions.publish'];

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
const folders: string[] = [];
let sql0127: string[];
let levelRowsBefore: unknown[];

/** Seeded grants, none of the publish permissions. */
let tenantA: TenantWithEntity;
/** A Founder already gave Management the workflow read at scope own. */
let tenantB: TenantWithEntity;
/** Every role already holds what 0127 grants. */
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
              set_config('bos.actor_id', 'workflow-publish-migration-test', true),
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

/** `role permission scope seeded` for the publish permissions of one tenant, sorted. */
async function publishGrantsOf(tenantId: string): Promise<string[]> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    scope: string;
    seeded: boolean;
  }>(
    `SELECT role_key, permission, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = ANY($2::text[])`,
    [tenantId, PUBLISH_PERMISSIONS],
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
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos';
  const ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  const beforeFolder = await folderOf(journal, index, 'before-0127');
  const throughFolder = await folderOf(journal, index + 1, 'through-0127');
  sql0127 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenantA = await seedTenant(
    [
      ['founder', 'admin.settings.write', 'all', true],
      ['management', 'quotation.read', 'all', true],
      ['finance', 'approvals.definitions.read', 'all', true],
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
      ['management', 'approvals.definitions.read', 'own', false],
    ],
    1,
  );
  tenantHeld = await seedTenant(
    [
      ['management', 'approvals.definitions.read', 'all', true],
      ['management', 'approvals.definitions.publish', 'all', true],
      ['founder', 'approvals.definitions.publish', 'all', true],
    ],
    5,
  );
  tenantC = await createTenantWithEntity(owner);
  levelRowsBefore = await levelRows();

  // The real runner now applies 0127 and nothing after it.
  await runMigrations(ownerUrl, throughFolder);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0127 workflow publish', () => {
  it('records who saved a version: workflow_versions.created_by, a nullable uuid', async () => {
    const { rows } = await owner.query<{ data_type: string; is_nullable: string }>(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'workflow_versions' AND column_name = 'created_by'`,
    );
    expect(rows).toEqual([{ data_type: 'uuid', is_nullable: 'YES' }]);
  });

  it('lets Management read and publish workflows and the Founder publish them, at scope all, seeded', async () => {
    expect(await publishGrantsOf(tenantA.tenantId)).toEqual([
      'finance approvals.definitions.read all true',
      'founder approvals.definitions.publish all true',
      'management approvals.definitions.publish all true',
      'management approvals.definitions.read all true',
    ]);
  });

  it('keeps a row a Founder made, whatever its scope, and still adds the missing ones', async () => {
    expect(await publishGrantsOf(tenantB.tenantId)).toEqual([
      'founder approvals.definitions.publish all true',
      'management approvals.definitions.publish all true',
      'management approvals.definitions.read own false',
    ]);
  });

  it('gives no other role the publish permission and leaves the other rows alone', async () => {
    const { rows } = await owner.query<{ role_key: string; permission: string; scope: string }>(
      `SELECT role_key, permission, scope FROM app.role_permissions
        WHERE tenant_id = $1 AND NOT (permission = ANY($2::text[])) ORDER BY 1, 2`,
      [tenantA.tenantId, PUBLISH_PERMISSIONS],
    );
    expect(rows).toEqual([
      { role_key: 'founder', permission: 'admin.settings.write', scope: 'all' },
      { role_key: 'management', permission: 'quotation.read', scope: 'all' },
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
        WHERE tenant_id = $1 AND entity_type = 'role_permissions' AND actor_id = 'system:migration-0127'`,
      [tenantA.tenantId],
    );
    expect(Number(rows[0]!.n)).toBe(3);
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
    expect(sql0127).toHaveLength(4);
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0127) await client.query(statement);
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
