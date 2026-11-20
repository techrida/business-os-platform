// Integration test for migration 0093 (FX-Q3): invited and inactive members a retired department left behind are
// unassigned (department NULL, level staff), each with a `department.member.removed` event, and nothing else changes.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/retired-department-members-migration.test.ts
//
// The database is migrated with the real SQL up to 0092, given departments retired the way the old retire route
// left them (only active members moved out), then migrated with the real runner, which applies 0093 and anything
// later.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createDepartment,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const TAG = '0093_retired_department_members_repair';
const ACTOR = 'system:migration-0093';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Membership {
  department_id: string | null;
  level: string;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0093: string[];

let tenant: TenantWithEntity;
let other: TenantWithEntity;
let retiredDept: string;
let activeDept: string;
let otherRetiredDept: string;

const user = {} as {
  invitedManager: string;
  inactiveStaff: string;
  activeInRetired: string;
  invitedInActive: string;
  otherTenantInvited: string;
};

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
              set_config('bos.actor_id', 'retired-department-migration-test', true),
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

/** A staff member of `departmentId` with the given user status and membership level. */
async function member(
  scope: TenantWithEntity,
  departmentId: string,
  status: 'invited' | 'active' | 'inactive',
  level: 'staff' | 'manager',
): Promise<string> {
  const { userId } = await createStaffUser(owner, { ...scope, departmentId });
  await writeAs(scope, async (c) => {
    await c.query('UPDATE app.users SET status = $2 WHERE id = $1', [userId, status]);
    await c.query('UPDATE app.user_entities SET level = $2 WHERE user_id = $1', [userId, level]);
  });
  return userId;
}

/** The department as the old retire route left it: retired, members other than active ones still in it. */
async function retire(scope: TenantWithEntity, departmentId: string): Promise<void> {
  await writeAs(scope, (c) =>
    c.query(
      `UPDATE app.departments SET status = 'retired', retired_at = now(), head_user_id = NULL WHERE id = $1`,
      [departmentId],
    ),
  );
}

async function memberships(): Promise<Map<string, Membership>> {
  const { rows } = await owner.query<Membership & { user_id: string }>(
    'SELECT user_id, department_id, level FROM app.user_entities',
  );
  return new Map(
    rows.map((row) => [row.user_id, { department_id: row.department_id, level: row.level }]),
  );
}

async function migrationEvents(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1',
    [ACTOR],
  );
  return Number(rows[0]!.n);
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
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0093-'));
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
  sql0093 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenant = await createTenantWithEntity(owner);
  other = await createTenantWithEntity(owner);
  retiredDept = (await createDepartment(owner, tenant)).departmentId;
  activeDept = (await createDepartment(owner, tenant)).departmentId;
  otherRetiredDept = (await createDepartment(owner, other)).departmentId;

  user.invitedManager = await member(tenant, retiredDept, 'invited', 'manager');
  user.inactiveStaff = await member(tenant, retiredDept, 'inactive', 'staff');
  user.activeInRetired = await member(tenant, retiredDept, 'active', 'manager');
  user.invitedInActive = await member(tenant, activeDept, 'invited', 'manager');
  user.otherTenantInvited = await member(other, otherRetiredDept, 'invited', 'manager');

  await retire(tenant, retiredDept);
  await retire(other, otherRetiredDept);

  // The real runner now applies 0093 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0093 retired department members repair', () => {
  it('unassigns invited and inactive members of a retired department and resets their level', async () => {
    const after = await memberships();
    for (const id of [user.invitedManager, user.inactiveStaff, user.otherTenantInvited]) {
      expect(after.get(id), id).toEqual({ department_id: null, level: 'staff' });
    }
  });

  it('leaves active members of a retired department and members of an active department alone', async () => {
    const after = await memberships();
    expect(after.get(user.activeInRetired)).toEqual({
      department_id: retiredDept,
      level: 'manager',
    });
    expect(after.get(user.invitedInActive)).toEqual({
      department_id: activeDept,
      level: 'manager',
    });
  });

  it('records one department.member.removed event per repaired member, in its own tenant and entity', async () => {
    const { rows } = await owner.query<{
      tenant_id: string;
      organization_id: string;
      entity_type: string;
      entity_id: string;
      before: unknown;
      after: unknown;
      meta: unknown;
    }>(
      `SELECT tenant_id, organization_id, entity_type, entity_id, before, after, meta
         FROM audit.audit_events
        WHERE action = 'department.member.removed' AND actor_id = $1
        ORDER BY meta ->> 'userId'`,
      [ACTOR],
    );
    expect(rows).toHaveLength(3);
    const byUser = new Map(rows.map((row) => [(row.meta as { userId: string }).userId, row]));
    expect(byUser.get(user.invitedManager)).toEqual({
      tenant_id: tenant.tenantId,
      organization_id: tenant.organizationId,
      entity_type: 'departments',
      entity_id: retiredDept,
      before: { departmentId: retiredDept, level: 'manager' },
      after: { departmentId: null, level: 'staff' },
      meta: { userId: user.invitedManager, reason: 'retired_department_repair' },
    });
    expect(byUser.get(user.inactiveStaff)).toMatchObject({
      entity_id: retiredDept,
      before: { departmentId: retiredDept, level: 'staff' },
    });
    expect(byUser.get(user.otherTenantInvited)).toMatchObject({
      tenant_id: other.tenantId,
      organization_id: other.organizationId,
      entity_id: otherRetiredDept,
    });
  });

  it('keeps the row audit of each membership change', async () => {
    const { rows } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE entity_type = 'user_entities' AND actor_id = $1`,
      [ACTOR],
    );
    expect(Number(rows[0]!.n)).toBe(3);
  });

  it('finds nothing to repair when it runs again', async () => {
    const before = await memberships();
    const eventsBefore = await migrationEvents();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0093) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await memberships()).toEqual(before);
    expect(await migrationEvents()).toBe(eventsBefore);
  });
});
