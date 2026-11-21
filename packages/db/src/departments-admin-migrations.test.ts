// Integration test for migration 0086_departments_admin: department lifecycle (status, retired_at, version),
// case-insensitive active name uniqueness per legal entity, trigram search index, and user_entities.department_since
// backfill + trigger.
// Needs Docker: a database of its own in the run's shared postgres:16-alpine container (no compose stack is involved).
// Run with:
//   pnpm --filter @bos/db exec vitest run src/departments-admin-migrations.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TARGET_TAG = '0086_departments_admin';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let owner: Pool;
let beforeFolder: string;

let tenantA: TenantWithEntity;
let secondEntityId: string;
let existingDeptId: string;
let assignedUserId: string;
let unassignedUserId: string;

/** One transaction as bos_owner with the audit settings the triggers demand. */
async function writeAs<T>(
  scope: { tenantId: string; organizationId: string },
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'departments-admin-migration-test', true),
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

async function one<T>(sql: string, values: unknown[]): Promise<T> {
  const { rows } = await owner.query(sql, values);
  return rows[0] as T;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  const ownerUrl = testDb.ownerUrl;
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TARGET_TAG);
  expect(index, `${TARGET_TAG} is in the journal`).toBeGreaterThan(0);

  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0086-'));
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
  await runMigrations(ownerUrl, beforeFolder);

  // Seed a populated tenant before 0086 runs: one existing department, one assigned member,
  // one unassigned member, and a second legal entity under the same tenant.
  tenantA = await createTenantWithEntity(owner);
  secondEntityId = randomUUID();
  await writeAs(tenantA, (c) =>
    c.query(
      `INSERT INTO app.organizations (id, tenant_id, organization_id, code, name, legal_name, is_default)
       VALUES ($1, $2, $1, 'E-SECOND', 'Second Entity', 'Second Entity Pvt. Ltd.', false)`,
      [secondEntityId, tenantA.tenantId],
    ),
  );
  existingDeptId = (await createDepartment(owner, { ...tenantA, name: 'Sales' })).departmentId;
  assignedUserId = (await createStaffUser(owner, { ...tenantA, departmentId: existingDeptId }))
    .userId;
  unassignedUserId = (await createStaffUser(owner, tenantA)).userId;

  // Apply 0086 via the real migration runner.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await testDb?.drop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0086 backfill on populated data', () => {
  it('defaults existing departments to active, retired_at null, and version 1', async () => {
    const row = await one<{ status: string; retired_at: Date | null; version: number }>(
      'SELECT status, retired_at, version FROM app.departments WHERE id = $1',
      [existingDeptId],
    );
    expect(row.status).toBe('active');
    expect(row.retired_at).toBeNull();
    expect(row.version).toBe(1);
  });

  it('backfills department_since from created_at for assigned members and leaves unassigned null', async () => {
    const assigned = await one<{ created_at: Date; department_since: Date | null }>(
      'SELECT created_at, department_since FROM app.user_entities WHERE user_id = $1',
      [assignedUserId],
    );
    expect(assigned.department_since).not.toBeNull();
    expect(assigned.department_since?.getTime()).toBe(assigned.created_at.getTime());

    const unassigned = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [unassignedUserId],
    );
    expect(unassigned.department_since).toBeNull();
  });
});

describe('0086 department lifecycle constraints and active name uniqueness', () => {
  it('enforces status, retired_at pairing, and positive version checks', async () => {
    await expect(
      writeAs(tenantA, (c) =>
        c.query('UPDATE app.departments SET status = $2 WHERE id = $1', [
          existingDeptId,
          'archived',
        ]),
      ),
    ).rejects.toThrow(/departments_(status|retired_at)_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query("UPDATE app.departments SET status = 'retired', retired_at = NULL WHERE id = $1", [
          existingDeptId,
        ]),
      ),
    ).rejects.toThrow(/departments_retired_at_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query("UPDATE app.departments SET status = 'active', retired_at = now() WHERE id = $1", [
          existingDeptId,
        ]),
      ),
    ).rejects.toThrow(/departments_retired_at_check/);

    await expect(
      writeAs(tenantA, (c) =>
        c.query('UPDATE app.departments SET version = 0 WHERE id = $1', [existingDeptId]),
      ),
    ).rejects.toThrow(/departments_version_check/);
  });

  it('prevents case-insensitive duplicate active names in the same entity, while allowing retired duplicates and other entities', async () => {
    // Duplicate active name in different case + whitespace in the same entity is rejected.
    await expect(createDepartment(owner, { ...tenantA, name: '  sAlEs  ' })).rejects.toThrow(
      /departments_tenant_org_active_name_unique/,
    );

    // Same name in another legal entity of the same tenant is allowed.
    const otherEntityDept = await createDepartment(owner, {
      tenantId: tenantA.tenantId,
      organizationId: secondEntityId,
      name: 'Sales',
    });
    expect(otherEntityDept.departmentId).toBeTruthy();

    // Retiring a department frees its active name in that entity.
    const temp = await createDepartment(owner, { ...tenantA, name: 'Operations' });
    await writeAs(tenantA, (c) =>
      c.query(
        "UPDATE app.departments SET status = 'retired', retired_at = now(), version = version + 1 WHERE id = $1",
        [temp.departmentId],
      ),
    );
    const recreated = await createDepartment(owner, { ...tenantA, name: 'operations' });
    expect(recreated.departmentId).not.toBe(temp.departmentId);
  });
});

describe('0086 department_since trigger', () => {
  it('sets, updates, preserves, and clears department_since as membership changes', async () => {
    const deptA = (await createDepartment(owner, { ...tenantA, name: 'Engineering' })).departmentId;
    const deptB = (await createDepartment(owner, { ...tenantA, name: 'Finance' })).departmentId;

    // Inserted directly into a department -> department_since populated.
    const freshAssigned = (await createStaffUser(owner, { ...tenantA, departmentId: deptA }))
      .userId;
    const freshRow = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [freshAssigned],
    );
    expect(freshRow.department_since).not.toBeNull();

    // Unassigned user joins deptA -> department_since set.
    const joined = (await createStaffUser(owner, tenantA)).userId;
    await writeAs(tenantA, (c) =>
      c.query('UPDATE app.user_entities SET department_id = $2 WHERE user_id = $1', [
        joined,
        deptA,
      ]),
    );
    const afterJoin = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [joined],
    );
    expect(afterJoin.department_since).not.toBeNull();

    // Updating level or job_title without changing department_id preserves department_since.
    await writeAs(tenantA, (c) =>
      c.query(
        "UPDATE app.user_entities SET level = 'manager', job_title = 'Team lead' WHERE user_id = $1",
        [joined],
      ),
    );
    const afterLevel = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [joined],
    );
    expect(afterLevel.department_since?.getTime()).toBe(afterJoin.department_since?.getTime());

    // Moving to deptB refreshes department_since.
    await writeAs(tenantA, (c) =>
      c.query('UPDATE app.user_entities SET department_since = $2 WHERE user_id = $1', [
        joined,
        new Date('2020-01-01T00:00:00.000Z'),
      ]),
    );
    await writeAs(tenantA, (c) =>
      c.query('UPDATE app.user_entities SET department_id = $2 WHERE user_id = $1', [
        joined,
        deptB,
      ]),
    );
    const afterMove = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [joined],
    );
    expect(afterMove.department_since).not.toBeNull();
    expect(afterMove.department_since!.getTime()).toBeGreaterThan(
      new Date('2020-01-01T00:00:00.000Z').getTime(),
    );

    // Removing from department clears department_since to NULL.
    await writeAs(tenantA, (c) =>
      c.query(
        "UPDATE app.user_entities SET department_id = NULL, level = 'staff' WHERE user_id = $1",
        [joined],
      ),
    );
    const afterRemove = await one<{ department_since: Date | null }>(
      'SELECT department_since FROM app.user_entities WHERE user_id = $1',
      [joined],
    );
    expect(afterRemove.department_since).toBeNull();
  });
});
