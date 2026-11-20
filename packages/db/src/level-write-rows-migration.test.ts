// Integration test for migration 0122 (U20a2-Q9): a department see row on leads or opportunities gets the matching
// write row for the same role and level, on tenants with stored grants, and nothing else changes.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/level-write-rows-migration.test.ts
//
// The database is migrated with the real SQL up to the entry before 0122, given level rows the way an early Settings
// > Access save left them (see rows only, level_rules_materialized set), then migrated with the real runner.
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
const TAG = '0122_level_write_rows_for_department_reach';
const ACTOR = 'system:migration-0122';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

type Grant = [role: string, permission: string, scope: string];
type LevelRow = [
  role: string,
  permission: string,
  minLevel: 'manager' | 'head',
  scope: string,
  seeded: boolean,
];

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0122: string[];

/** Materialised by an early save: see rows only. */
let seeOnly: TenantWithEntity;
/** Materialised with every switch off: no level rows. */
let switchesOff: TenantWithEntity;
/** Already paired, or a write the role holds at department or wider. */
let clean: TenantWithEntity;
/** No stored grants: still on the code defaults. */
let codeDefaults: TenantWithEntity;

/** One transaction as bos_owner in `scope`, with the audit settings the triggers demand. */
async function writeAs<T>(
  scope: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'level-write-rows-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.tenant_id', $2, true),
              set_config('bos.organization_id', $3, true)`,
      [randomUUID(), scope.tenantId, scope.organizationId],
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

async function seed(
  scope: TenantWithEntity,
  options: { grants: Grant[]; levels: LevelRow[]; materialized: boolean; version: number | null },
): Promise<void> {
  await writeAs(scope, async (c) => {
    for (const [role, permission, grantScope] of options.grants) {
      await c.query(
        `INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope, seeded)
         VALUES ($1, $2, $3, $4, true)`,
        [scope.tenantId, role, permission, grantScope],
      );
    }
    for (const [role, permission, minLevel, levelScope, seeded] of options.levels) {
      await c.query(
        `INSERT INTO app.role_permission_levels (tenant_id, role_key, permission, min_level, scope, seeded)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [scope.tenantId, role, permission, minLevel, levelScope, seeded],
      );
    }
    if (options.materialized) {
      await c.query(
        'INSERT INTO app.access_revisions (tenant_id, revision, level_rules_materialized) VALUES ($1, 1, true)',
        [scope.tenantId],
      );
    }
    if (options.version !== null) {
      await c.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, $2)', [
        scope.tenantId,
        options.version,
      ]);
    }
  });
}

async function levelRows(scope: TenantWithEntity): Promise<string[]> {
  const { rows } = await owner.query<{
    role_key: string;
    permission: string;
    min_level: string;
    scope: string;
    seeded: boolean;
  }>(
    `SELECT role_key, permission, min_level, scope, seeded FROM app.role_permission_levels
      WHERE tenant_id = $1 ORDER BY role_key, permission, min_level`,
    [scope.tenantId],
  );
  return rows.map(
    (r) =>
      `${r.role_key} ${r.permission} ${r.min_level} ${r.scope} ${r.seeded ? 'seeded' : 'custom'}`,
  );
}

async function version(scope: TenantWithEntity): Promise<number | null> {
  const { rows } = await owner.query<{ version: number }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [scope.tenantId],
  );
  return rows[0]?.version ?? null;
}

async function migrationEvents(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1',
    [ACTOR],
  );
  return Number(rows[0]!.n);
}

const salesGrants: Grant[] = [
  ['sales', 'crm.lead.read', 'own'],
  ['sales', 'crm.lead.write', 'own'],
  ['sales', 'crm.opportunity.read', 'own'],
  ['sales', 'crm.opportunity.write', 'own'],
];

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
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0122-'));
  await mkdir(join(beforeFolder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(beforeFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(beforeFolder, `${entry.tag}.sql`),
    );
  }
  sql0122 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  seeOnly = await createTenantWithEntity(owner);
  await seed(seeOnly, {
    grants: [
      ...salesGrants,
      ['marketing', 'crm.lead.read', 'own'],
      ['marketing', 'crm.lead.write', 'own'],
      ['finance', 'crm.lead.read', 'own'],
      ['finance', 'crm.lead.write', 'own'],
    ],
    levels: [
      ['sales', 'crm.lead.read', 'manager', 'department', true],
      ['sales', 'crm.lead.read', 'head', 'department', true],
      // The Founder turned the opportunities manager switch off: only the head row.
      ['sales', 'crm.opportunity.read', 'head', 'department', false],
      ['marketing', 'crm.lead.read', 'manager', 'department', true],
      ['finance', 'crm.lead.read', 'manager', 'department', true],
    ],
    materialized: true,
    version: 4,
  });

  switchesOff = await createTenantWithEntity(owner);
  await seed(switchesOff, {
    grants: salesGrants,
    levels: [],
    materialized: true,
    version: 2,
  });

  clean = await createTenantWithEntity(owner);
  await seed(clean, {
    grants: [
      ['sales', 'crm.lead.read', 'own'],
      ['sales', 'crm.lead.write', 'own'],
      ['sales', 'crm.opportunity.read', 'own'],
      // Already at department: the level row would add nothing.
      ['sales', 'crm.opportunity.write', 'department'],
      // Holds no write at all: a level row never creates access.
      ['marketing', 'crm.lead.read', 'own'],
    ],
    levels: [
      ['sales', 'crm.lead.read', 'manager', 'department', true],
      // An existing write row is kept, whatever its scope.
      ['sales', 'crm.lead.write', 'manager', 'own', false],
      ['sales', 'crm.opportunity.read', 'manager', 'department', true],
      ['marketing', 'crm.lead.read', 'manager', 'department', true],
    ],
    materialized: false,
    version: 1,
  });

  codeDefaults = await createTenantWithEntity(owner);
  await seed(codeDefaults, {
    grants: [],
    levels: [['sales', 'crm.lead.read', 'manager', 'department', true]],
    materialized: false,
    version: null,
  });

  // The real runner now applies 0122 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0122 level write rows for department reach', () => {
  it('pairs each department see row with its write row at the same level, keeping seeded', async () => {
    expect(await levelRows(seeOnly)).toEqual([
      'finance crm.lead.read manager department seeded',
      'marketing crm.lead.read manager department seeded',
      'marketing crm.lead.write manager department seeded',
      'sales crm.lead.read head department seeded',
      'sales crm.lead.read manager department seeded',
      'sales crm.lead.write head department seeded',
      'sales crm.lead.write manager department seeded',
      'sales crm.opportunity.read head department custom',
      'sales crm.opportunity.write head department custom',
    ]);
    expect(await version(seeOnly)).toBe(5);
  });

  it('gives a lead intake role no write row', async () => {
    const rows = await levelRows(seeOnly);
    expect(rows.filter((row) => row.startsWith('finance crm.lead.write'))).toEqual([]);
  });

  it('turns no switch on: a tenant with every switch off keeps no rows and its version', async () => {
    expect(await levelRows(switchesOff)).toEqual([]);
    expect(await version(switchesOff)).toBe(2);
  });

  it('keeps existing write rows and adds none where the write is already wide or missing', async () => {
    expect(await levelRows(clean)).toEqual([
      'marketing crm.lead.read manager department seeded',
      'sales crm.lead.read manager department seeded',
      'sales crm.lead.write manager own custom',
      'sales crm.opportunity.read manager department seeded',
    ]);
    expect(await version(clean)).toBe(1);
  });

  it('leaves a tenant without stored grants alone', async () => {
    expect(await levelRows(codeDefaults)).toEqual([
      'sales crm.lead.read manager department seeded',
    ]);
    expect(await version(codeDefaults)).toBeNull();
  });

  it('records each added row in the audit trail as the migration', async () => {
    const { rows } = await owner.query<{ tenant_id: string; n: string }>(
      `SELECT tenant_id, count(*) AS n FROM audit.audit_events
        WHERE entity_type = 'role_permission_levels' AND actor_id = $1
        GROUP BY tenant_id`,
      [ACTOR],
    );
    expect(rows.map((row) => ({ tenant: row.tenant_id, n: Number(row.n) }))).toEqual([
      { tenant: seeOnly.tenantId, n: 4 },
    ]);
  });

  it('changes nothing when it runs again', async () => {
    const tenants = [seeOnly, switchesOff, clean, codeDefaults];
    const before = await Promise.all(
      tenants.map(async (t) => [await levelRows(t), await version(t)]),
    );
    const eventsBefore = await migrationEvents();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0122) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    const after = await Promise.all(
      tenants.map(async (t) => [await levelRows(t), await version(t)]),
    );
    expect(after).toEqual(before);
    expect(await migrationEvents()).toBe(eventsBefore);
  });
});
