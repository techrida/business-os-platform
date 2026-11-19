// Integration test for migration 0055_quotation_cost_read_permission (D29a): every role that drafts or approves
// quotations gets `quotation.cost.read` at scope all, the authz cache version is bumped only for the tenants that
// gained a row, and a second run adds nothing.
// Needs Docker: a real postgres:16-alpine from Testcontainers. Run with:
//   pnpm --filter @bos/db exec vitest run src/quotation-cost-read-migration.test.ts
//
// The database is first migrated with the real SQL up to 0047 (the migration before 0055), seeded with
// role_permissions rows like a tenant that has been running, and then migrated with the real runner, which
// applies 0055 (and any later migration). Writes set the bos.* audit settings the triggers demand.
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
const TAG = '0055_quotation_cost_read_permission';
const PERMISSION = 'quotation.cost.read';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let ownerUrl: string;
let before0055Folder: string;
let sql0055: string[];

let tenantA: TenantWithEntity;
let tenantB: TenantWithEntity;
let tenantC: TenantWithEntity;

/** One transaction as bos_owner with the audit settings the role_permissions trigger needs. */
async function writeAs<T>(
  org: TenantWithEntity,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'cost-read-migration-test', true),
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

async function grant(
  org: TenantWithEntity,
  roleKey: string,
  permission: string,
  scope = 'own',
): Promise<void> {
  await writeAs(org, (client) =>
    client.query(
      'INSERT INTO app.role_permissions (tenant_id, role_key, permission, scope) VALUES ($1, $2, $3, $4)',
      [org.tenantId, roleKey, permission, scope],
    ),
  );
}

/** role_key to scope, for the new permission in one tenant. */
async function costReaders(org: TenantWithEntity): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ role_key: string; scope: string }>(
    'SELECT role_key, scope FROM app.role_permissions WHERE tenant_id = $1 AND permission = $2 ORDER BY role_key',
    [org.tenantId, PERMISSION],
  );
  return Object.fromEntries(rows.map((row) => [row.role_key, row.scope]));
}

async function authzVersion(org: TenantWithEntity): Promise<number | null> {
  const { rows } = await owner.query<{ version: string }>(
    'SELECT version FROM app.authz_versions WHERE tenant_id = $1',
    [org.tenantId],
  );
  return rows[0] === undefined ? null : Number(rows[0].version);
}

async function rowCount(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM app.role_permissions',
  );
  return Number(rows[0]?.n);
}

/** Runs the statements of 0055 as one transaction, the way the runner does. */
async function runSql0055Again(): Promise<void> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    for (const statement of sql0055) await client.query(statement);
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
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos';
  ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  // The real SQL and journal up to the migration before 0055.
  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  before0055Folder = await mkdtemp(join(tmpdir(), 'bos-before-0055-'));
  await mkdir(join(before0055Folder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(before0055Folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(before0055Folder, `${entry.tag}.sql`),
    );
  }
  sql0055 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );

  await runMigrations(ownerUrl, before0055Folder);

  // Tenant A: a default sales role, a custom role with neither permission, an approver-only role, a role
  // that already holds the new permission (as a narrower scope), and a founder-like role.
  tenantA = await createTenantWithEntity(owner);
  await grant(tenantA, 'sales', 'quotation.read');
  await grant(tenantA, 'sales', 'quotation.draft');
  await grant(tenantA, 'custom_reader', 'quotation.read');
  await grant(tenantA, 'custom_reader', 'memo.read');
  await grant(tenantA, 'approver_only', 'approvals.requests.act', 'all');
  await grant(tenantA, 'already_has', 'quotation.draft');
  await grant(tenantA, 'already_has', PERMISSION, 'own');
  await grant(tenantA, 'both', 'quotation.draft');
  await grant(tenantA, 'both', 'approvals.requests.act', 'all');
  await writeAs(tenantA, (client) =>
    client.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 3)', [
      tenantA.tenantId,
    ]),
  );

  // Tenant B: only roles that hold neither permission, so nothing is inserted and the version stays.
  tenantB = await createTenantWithEntity(owner);
  await grant(tenantB, 'custom_reader', 'quotation.read');
  await grant(tenantB, 'ops', 'sales_order.read');
  await writeAs(tenantB, (client) =>
    client.query('INSERT INTO app.authz_versions (tenant_id, version) VALUES ($1, 7)', [
      tenantB.tenantId,
    ]),
  );

  // Tenant C: a drafting role and no authz_versions row yet, so one is created at version 1.
  tenantC = await createTenantWithEntity(owner);
  await grant(tenantC, 'pmo', 'quotation.draft');

  // The real runner now applies only 0055.
  await runMigrations(ownerUrl);
}, 120_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (before0055Folder) await rm(before0055Folder, { recursive: true, force: true });
});

describe('0055 quotation.cost.read for existing roles', () => {
  it('gives it, at scope all, to roles holding quotation.draft or approvals.requests.act', async () => {
    expect(await costReaders(tenantA)).toEqual({
      sales: 'all',
      approver_only: 'all',
      both: 'all',
      already_has: 'own',
    });
    expect(await costReaders(tenantC)).toEqual({ pmo: 'all' });
  });

  it('gives nothing to a role customised to hold neither permission', async () => {
    const { rows } = await owner.query(
      'SELECT 1 FROM app.role_permissions WHERE tenant_id = $1 AND role_key = $2 AND permission = $3',
      [tenantA.tenantId, 'custom_reader', PERMISSION],
    );
    expect(rows).toHaveLength(0);
    expect(await costReaders(tenantB)).toEqual({});
  });

  it('keeps a role that already held the permission as it was, without a duplicate', async () => {
    const { rows } = await owner.query<{ scope: string }>(
      'SELECT scope FROM app.role_permissions WHERE tenant_id = $1 AND role_key = $2 AND permission = $3',
      [tenantA.tenantId, 'already_has', PERMISSION],
    );
    expect(rows).toEqual([{ scope: 'own' }]);
  });

  it('bumps authz_versions only for tenants that gained a row', async () => {
    expect(await authzVersion(tenantA)).toBe(4);
    expect(await authzVersion(tenantB)).toBe(7);
    expect(await authzVersion(tenantC)).toBe(1);
  });

  it('records the migration as the audit actor', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE actor_id = 'system:migration-0055' AND tenant_id = $1`,
      [tenantA.tenantId],
    );
    expect(Number(rows[0]?.n)).toBe(3);
  });

  it('adds nothing and bumps nothing when its statements run again', async () => {
    const rowsBefore = await rowCount();
    await runSql0055Again();
    await runSql0055Again();
    expect(await rowCount()).toBe(rowsBefore);
    expect(await authzVersion(tenantA)).toBe(4);
    expect(await authzVersion(tenantB)).toBe(7);
    expect(await authzVersion(tenantC)).toBe(1);
  });

  it('is not re-applied by the runner', async () => {
    const rowsBefore = await rowCount();
    await runMigrations(ownerUrl);
    expect(await rowCount()).toBe(rowsBefore);
  });
});
