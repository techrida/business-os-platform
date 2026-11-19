// Integration test for the grants in migration 0053_user_avatar (U12): `profile.avatar.write` at scope all for
// founder and any role holding admin.users.invite, scope own for the named staff roles (marketing included), the
// authz cache version bumped once, and the `seeded` flag right in both orders 0053 can run in.
// Needs Docker: a real postgres:16-alpine from Testcontainers. Run with:
//   pnpm --filter @bos/db exec vitest run src/avatar-permission-migration.test.ts
//
// Two databases, both seeded with role_permissions rows like a tenant that has been running:
//   * in order: migrated up to the migration before 0053, then the real runner applies 0053 and everything after
//     it (0081 adds `seeded` later and backfills it; 0083 adds the Marketing rows later).
//   * ahead: migrated with every migration except U12's 0053, 0054 and 0058 (so 0081 and 0083 have run), then the
//     real runner applies those three late, the way a database already on the later phase receives them.
// Writes set the bos.* audit settings the triggers demand.
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
const TAG = '0053_user_avatar';
const U12_TAGS = new Set([TAG, '0054_party_logos', '0058_legacy_company_logo']);
const PERMISSION = 'profile.avatar.write';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Journal {
  entries: JournalEntry[];
}

interface Grant {
  scope: string;
  seeded: boolean;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
const folders: string[] = [];
let sql0053: string[];

let inOrder: Pool;
let inOrderUrl: string;
let inOrderTenant: TenantWithEntity;

let ahead: Pool;
let aheadUrl: string;
let aheadTenant: TenantWithEntity;
let aheadVersionBefore: number;

/** A migrations folder holding the real SQL of the given journal entries, in journal order. */
async function folderOf(journal: Journal, entries: JournalEntry[], name: string): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
  folders.push(folder);
  await mkdir(join(folder, 'meta'));
  await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(folder, `${entry.tag}.sql`),
    );
  }
  return folder;
}

async function createDatabase(name: string): Promise<{ pool: Pool; url: string }> {
  await admin.query(`CREATE DATABASE ${name} OWNER bos_owner`);
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = `/${name}`;
  return { pool: new Pool({ connectionString: url.toString(), max: 2 }), url: url.toString() };
}

/** One transaction as bos_owner with the audit settings the role_permissions trigger needs. */
async function writeAs<T>(
  pool: Pool,
  org: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'avatar-migration-test', true),
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

/** A running tenant's grants before 0053: founder, two staff roles, a user manager and a custom role. */
async function seedRunningTenant(pool: Pool): Promise<TenantWithEntity> {
  const org = await createTenantWithEntity(pool);
  const rows: [string, string, string][] = [
    ['founder', 'memo.read', 'all'],
    ['sales', 'quotation.read', 'own'],
    ['finance', 'memo.read', 'all'],
    ['user_admin', 'admin.users.invite', 'all'],
    ['custom_reader', 'memo.read', 'own'],
  ];
  await writeAs(pool, org, async (client) => {
    for (const [roleKey, permission, scope] of rows) {
      await client.query(
        'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, $2, $3, $4)',
        [org.tenantId, roleKey, permission, scope],
      );
    }
    await client.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 3)', [
      org.tenantId,
    ]);
  });
  return org;
}

/** role_key to { scope, seeded } for the avatar permission in one tenant. */
async function avatarGrants(pool: Pool, org: TenantWithEntity): Promise<Record<string, Grant>> {
  const { rows } = await pool.query<{ role_key: string; scope: string; seeded: boolean }>(
    `SELECT role_key, scope, seeded FROM app.role_permissions
      WHERE tenant_id = $1 AND permission = $2 ORDER BY role_key`,
    [org.tenantId, PERMISSION],
  );
  return Object.fromEntries(
    rows.map((row) => [row.role_key, { scope: row.scope, seeded: row.seeded }]),
  );
}

async function authzVersion(pool: Pool, org: TenantWithEntity): Promise<number> {
  const { rows } = await pool.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [org.tenantId],
  );
  return Number(rows[0]?.version);
}

async function rowCount(pool: Pool): Promise<number> {
  const { rows } = await pool.query<{ n: string }>('SELECT count(*) AS n FROM app.role_permissions');
  return Number(rows[0]?.n);
}

/** Runs the grant statements of 0053 (all but the ALTER TABLE) as one transaction, the way the runner does. */
async function runGrantsAgain(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of sql0053) {
      if (statement.includes('ALTER TABLE')) continue;
      await client.query(statement);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as Journal;
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  const tags = journal.entries.map((entry) => entry.tag);
  // The premise of the "in order" case: on a database migrated in journal order 0053 runs before both of these.
  expect(tags.indexOf('0081_role_permissions_seeded')).toBeGreaterThan(index);
  expect(tags.indexOf('0083_marketing_role')).toBeGreaterThan(index);

  const before0053 = await folderOf(journal, journal.entries.slice(0, index), 'before-0053');
  const withoutU12 = await folderOf(
    journal,
    journal.entries.filter((entry) => !U12_TAGS.has(entry.tag)),
    'without-u12',
  );
  sql0053 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );

  ({ pool: inOrder, url: inOrderUrl } = await createDatabase('bos_in_order'));
  await runMigrations(inOrderUrl, before0053);
  inOrderTenant = await seedRunningTenant(inOrder);
  await runMigrations(inOrderUrl, MIGRATIONS_FOLDER);

  ({ pool: ahead, url: aheadUrl } = await createDatabase('bos_ahead'));
  await runMigrations(aheadUrl, before0053);
  aheadTenant = await seedRunningTenant(ahead);
  await runMigrations(aheadUrl, withoutU12);
  aheadVersionBefore = await authzVersion(ahead, aheadTenant);
  // The real runner now applies 0053, 0054 and 0058 after 0081 and 0083.
  await runMigrations(aheadUrl, MIGRATIONS_FOLDER);
}, 180_000);

afterAll(async () => {
  await inOrder?.end();
  await ahead?.end();
  await admin?.end();
  await container?.stop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0053 profile.avatar.write, applied in journal order (before 0081 and 0083)', () => {
  it('gives all to founder and the user manager and own to the staff roles; 0081 marks them seeded', async () => {
    expect(await avatarGrants(inOrder, inOrderTenant)).toEqual({
      founder: { scope: 'all', seeded: true },
      user_admin: { scope: 'all', seeded: true },
      finance: { scope: 'own', seeded: true },
      sales: { scope: 'own', seeded: true },
    });
  });

  it('leaves the Marketing role without it: 0083 adds Marketing after 0053 ran and does not grant it', async () => {
    // Pins the known gap reported to 0083's owner: once a tenant has rows the grant loader reads only the rows,
    // so a marketing user in such a tenant cannot set their own picture until a reseed adds the default.
    const { rows } = await inOrder.query<{ permission: string }>(
      `SELECT permission FROM app.role_permissions
        WHERE tenant_id = $1 AND role_key = 'marketing' ORDER BY permission`,
      [inOrderTenant.tenantId],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.map((row) => row.permission)).not.toContain(PERMISSION);
  });
});

describe('0053 profile.avatar.write, applied late on a database that already ran 0081 and 0083', () => {
  it('gives own to marketing and the other staff roles, and all to founder and the user manager', async () => {
    const grants = await avatarGrants(ahead, aheadTenant);
    expect(Object.fromEntries(Object.entries(grants).map(([role, g]) => [role, g.scope]))).toEqual({
      founder: 'all',
      user_admin: 'all',
      finance: 'own',
      marketing: 'own',
      sales: 'own',
    });
  });

  it('marks every new row seeded, the same end state as the journal-order path', async () => {
    expect(await avatarGrants(ahead, aheadTenant)).toEqual({
      founder: { scope: 'all', seeded: true },
      user_admin: { scope: 'all', seeded: true },
      finance: { scope: 'own', seeded: true },
      marketing: { scope: 'own', seeded: true },
      sales: { scope: 'own', seeded: true },
    });
  });

  it('gives nothing to a custom role without admin.users.invite', async () => {
    const grants = await avatarGrants(ahead, aheadTenant);
    expect(grants['custom_reader']).toBeUndefined();
  });

  it('bumps the authz version once', async () => {
    expect(await authzVersion(ahead, aheadTenant)).toBe(aheadVersionBefore + 1);
  });

  it('adds nothing and bumps nothing when its grant statements run again', async () => {
    const rowsBefore = await rowCount(ahead);
    await runGrantsAgain(ahead);
    await runGrantsAgain(ahead);
    expect(await rowCount(ahead)).toBe(rowsBefore);
    expect(await authzVersion(ahead, aheadTenant)).toBe(aheadVersionBefore + 1);
  });

  it('is not re-applied by the runner', async () => {
    const rowsBefore = await rowCount(ahead);
    await runMigrations(aheadUrl, MIGRATIONS_FOLDER);
    expect(await rowCount(ahead)).toBe(rowsBefore);
    expect(await authzVersion(ahead, aheadTenant)).toBe(aheadVersionBefore + 1);
  });
});
