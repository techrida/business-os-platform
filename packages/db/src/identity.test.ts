// Integration tests for migration 0002_identity_authz (users, departments, user_roles, role_permissions,
// authz_versions, ops.zitadel_events, ops.sync_cursors) and its Drizzle schema.
// Needs Docker: a real postgres:16-alpine from Testcontainers. Run with:
//   pnpm --filter @bos/db exec vitest run src/identity.test.ts
//
// The container starts with only a superuser, so beforeAll creates the same roles and default privileges that
// infra/postgres/init-dbs.sh creates, migrates as bos_owner and queries as bos_app (same path as production).
// Writes to app tables go through tx(), which sets the bos.* settings the audit trigger (0001) demands once it
// exists, so these tests behave the same before and after 0001 lands.
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { getTableConfig, type PgTable } from 'drizzle-orm/pg-core';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkTenancy } from './check-tenancy.js';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import {
  authzVersions,
  departments,
  rolePermissions,
  syncCursors,
  userRoles,
  users,
  zitadelEvents,
} from './schema/identity.js';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let owner: Pool;
let app: DbHandle;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** Runs `fn` in one transaction as bos_app with the bos.* actor settings set (the audit trigger needs them). */
async function tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await app.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'identity-test', true),
              set_config('bos.correlation_id', $1, true)`,
      [randomUUID()],
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

/** A tenant with one staff organization, ready to hold users and roles. */
async function makeOrg(): Promise<{ tenantId: string; organizationId: string }> {
  return tx(async (c) => {
    const t = await c.query<{ id: string }>('INSERT INTO app.tenants DEFAULT VALUES RETURNING id');
    const tenantId = t.rows[0]?.id ?? '';
    const o = await c.query<{ id: string }>(
      `INSERT INTO app.organizations (tenant_id, kind, name, zitadel_org_id)
       VALUES ($1, 'staff', 'Staff', $2) RETURNING id`,
      [tenantId, `zitadel-${randomUUID()}`],
    );
    return { tenantId, organizationId: o.rows[0]?.id ?? '' };
  });
}

/** Inserts a user (status given) and returns its id. */
async function makeUser(
  org: { tenantId: string; organizationId: string },
  status = 'active',
  zitadelUserId = `zu-${randomUUID()}`,
): Promise<string> {
  return tx(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, organization_id, zitadel_user_id, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [org.tenantId, org.organizationId, zitadelUserId, status],
    );
    return rows[0]?.id ?? '';
  });
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  owner = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  app = createDb(urlFor('bos_app', APP_PW, 'bos'), { max: 4 });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('0002 tables', () => {
  it('passes check-tenancy: every new app table has the tenancy columns', async () => {
    await expect(checkTenancy(owner)).resolves.toEqual([]);
  });

  it('created the five app tables and the two ops tables', async () => {
    const { rows } = await owner.query<{ t: string }>(
      `SELECT table_schema || '.' || table_name AS t FROM information_schema.tables
        WHERE table_schema IN ('app', 'ops')`,
    );
    expect(rows.map((r) => r.t)).toEqual(
      expect.arrayContaining([
        'app.departments',
        'app.users',
        'app.user_roles',
        'app.role_permissions',
        'app.authz_versions',
        'ops.zitadel_events',
        'ops.sync_cursors',
      ]),
    );
  });
});

// The Drizzle file must describe the SQL exactly: same columns, same nullability. A column added to one and
// forgotten in the other would otherwise only show up as a runtime error in some later unit.
describe('the Drizzle schema mirrors the SQL', () => {
  const tables: PgTable[] = [
    departments,
    users,
    userRoles,
    rolePermissions,
    authzVersions,
    zitadelEvents,
    syncCursors,
  ];

  it.each(tables.map((t) => [getTableConfig(t).name, t] as const))(
    '%s has the same columns and nullability as the database',
    async (_name, table) => {
      const config = getTableConfig(table);
      const { rows } = await owner.query<{ column_name: string; is_nullable: string }>(
        `SELECT column_name, is_nullable FROM information_schema.columns
          WHERE table_schema = $1 AND table_name = $2 ORDER BY column_name`,
        [config.schema, config.name],
      );
      const fromSql = rows.map((r) => [r.column_name, r.is_nullable === 'NO'] as const);
      const fromDrizzle = config.columns
        .map((c) => [c.name, c.notNull] as const)
        .sort((a, b) => a[0].localeCompare(b[0]));
      expect(fromDrizzle).toEqual(fromSql);
    },
  );

  it('round-trips a row through Drizzle (types, defaults and the FKs line up)', async () => {
    const org = await makeOrg();
    const zitadelUserId = `zu-${randomUUID()}`;
    await tx(async (c) => {
      await c.query(
        `INSERT INTO app.users (tenant_id, organization_id, zitadel_user_id, status)
         VALUES ($1, $2, $3, 'invited')`,
        [org.tenantId, org.organizationId, zitadelUserId],
      );
    });
    const [row] = await app.db.select().from(users).where(eq(users.zitadelUserId, zitadelUserId));
    expect(row).toMatchObject({
      tenantId: org.tenantId,
      organizationId: org.organizationId,
      status: 'invited',
      email: null,
      departmentId: null,
    });
  });
});

describe('app.users', () => {
  it('rejects a repeated zitadel_user_id (unique)', async () => {
    const org = await makeOrg();
    const sub = `zu-${randomUUID()}`;
    await makeUser(org, 'active', sub);
    await expect(makeUser(org, 'active', sub)).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects a status outside invited / active / inactive', async () => {
    const org = await makeOrg();
    await expect(makeUser(org, 'banned')).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an organization that does not exist', async () => {
    const org = await makeOrg();
    await expect(makeUser({ ...org, organizationId: randomUUID() })).rejects.toMatchObject({
      code: '23503',
    });
  });

  it('lets a department point at its head and a user at their department', async () => {
    const org = await makeOrg();
    const headId = await makeUser(org);
    const deptId = await tx(async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO app.departments (tenant_id, organization_id, name, head_user_id)
         VALUES ($1, $2, 'Sales', $3) RETURNING id`,
        [org.tenantId, org.organizationId, headId],
      );
      await c.query('UPDATE app.users SET department_id = $1 WHERE id = $2', [rows[0]?.id, headId]);
      return rows[0]?.id;
    });
    expect(deptId).toBeDefined();
    await expect(
      tx((c) =>
        c.query('UPDATE app.departments SET head_user_id = $1 WHERE id = $2', [
          randomUUID(),
          deptId,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('app.user_roles', () => {
  it('defaults source to zitadel, and its primary key is (user_id, role_key)', async () => {
    const org = await makeOrg();
    const userId = await makeUser(org);
    const insert = (roleKey: string) =>
      tx((c) =>
        c.query<{ source: string }>(
          `INSERT INTO app.user_roles (tenant_id, organization_id, user_id, role_key)
           VALUES ($1, $2, $3, $4) RETURNING source`,
          [org.tenantId, org.organizationId, userId, roleKey],
        ),
      );
    expect((await insert('finance')).rows[0]?.source).toBe('zitadel');
    await expect(insert('finance')).rejects.toMatchObject({ code: '23505' });
    // A second role for the same user is a different row.
    await expect(insert('sales')).resolves.toBeDefined();
  });

  it('rejects a role for a user that does not exist', async () => {
    const org = await makeOrg();
    await expect(
      tx((c) =>
        c.query(
          `INSERT INTO app.user_roles (tenant_id, organization_id, user_id, role_key)
           VALUES ($1, $2, $3, 'finance')`,
          [org.tenantId, org.organizationId, randomUUID()],
        ),
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });
});

describe('app.role_permissions', () => {
  const insert = (
    org: { tenantId: string; organizationId: string },
    scope: string,
    perm = 'x.read',
  ) =>
    tx((c) =>
      c.query(
        `INSERT INTO app.role_permissions (tenant_id, organization_id, role_key, permission, scope)
         VALUES ($1, $2, 'finance', $3, $4)`,
        [org.tenantId, org.organizationId, perm, scope],
      ),
    );

  it.each(['own', 'department', 'customer_org', 'all'])('accepts scope %s', async (scope) => {
    await expect(insert(await makeOrg(), scope)).resolves.toBeDefined();
  });

  it('rejects an unknown scope', async () => {
    await expect(insert(await makeOrg(), 'galaxy')).rejects.toMatchObject({ code: '23514' });
  });

  it('allows one row per (tenant, org, role, permission)', async () => {
    const org = await makeOrg();
    await insert(org, 'own');
    await expect(insert(org, 'all')).rejects.toMatchObject({ code: '23505' });
    await expect(insert(org, 'all', 'x.write')).resolves.toBeDefined();
  });
});

describe('app.authz_versions', () => {
  it('starts at version 0 and allows one row per organization', async () => {
    const org = await makeOrg();
    const insert = () =>
      tx((c) =>
        c.query<{ version: string }>(
          `INSERT INTO app.authz_versions (tenant_id, organization_id) VALUES ($1, $2) RETURNING version`,
          [org.tenantId, org.organizationId],
        ),
      );
    // bigint comes back from pg as a string.
    expect((await insert()).rows[0]?.version).toBe('0');
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });
});

describe('ops tables', () => {
  it('ops.zitadel_events: a replayed (instance, aggregate, sequence) is rejected', async () => {
    const insert = (sequence: number) =>
      app.pool.query(
        `INSERT INTO ops.zitadel_events (instance_id, aggregate_id, sequence, event_type)
         VALUES ('i1', 'a1', $1, 'user.human.added')`,
        [sequence],
      );
    await insert(1);
    await expect(insert(1)).rejects.toMatchObject({ code: '23505' });
    await expect(insert(2)).resolves.toBeDefined();
  });

  it('ops.sync_cursors: name is the primary key', async () => {
    const insert = () =>
      app.pool.query(`INSERT INTO ops.sync_cursors (name, cursor) VALUES ('reconcile', 'c1')`);
    await insert();
    await expect(insert()).rejects.toMatchObject({ code: '23505' });
  });

  it('lets bos_app select, insert and update both tables but never delete', async () => {
    for (const table of ['ops.zitadel_events', 'ops.sync_cursors']) {
      await expect(app.pool.query(`SELECT 1 FROM ${table}`)).resolves.toBeDefined();
      await expect(app.pool.query(`DELETE FROM ${table}`)).rejects.toMatchObject({ code: '42501' });
    }
    await expect(
      app.pool.query(`UPDATE ops.sync_cursors SET cursor = 'c2', updated_at = now()`),
    ).resolves.toBeDefined();
    await expect(
      app.pool.query(`UPDATE ops.zitadel_events SET processed_at = now()`),
    ).resolves.toBeDefined();
  });

  it('works through the Drizzle tables too', async () => {
    await app.db.insert(syncCursors).values({ name: 'drizzle-cursor', cursor: 'x' });
    const [row] = await app.db
      .select()
      .from(syncCursors)
      .where(eq(syncCursors.name, 'drizzle-cursor'));
    expect(row?.cursor).toBe('x');
    await app.db
      .insert(zitadelEvents)
      .values({ instanceId: 'i9', aggregateId: 'a9', sequence: 7, eventType: 'e' });
  });
});
