// Integration tests: a real, empty postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/db test
//
// The container starts with only a superuser, so beforeAll creates the same roles and default privileges that
// infra/postgres/init-dbs.sh creates in the real stack, then migrates as bos_owner and queries as bos_app.
// That way the tests walk the same path as production: owner migrates, app role does the daily work.
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertTenancy, checkTenancy } from './check-tenancy.js';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { organizations, restoreCanary, tenants } from './schema/platform.js';
import { scoped } from './scoped.js';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let app: DbHandle;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** Inserts a tenant and one organization (as bos_app) and returns their ids. */
async function insertOrg(kind: 'staff' | 'customer' | 'vendor', name: string, tenantId?: string) {
  const tenant =
    tenantId ?? (await app.db.insert(tenants).values({}).returning({ id: tenants.id }))[0]?.id;
  if (tenant === undefined) throw new Error('tenant insert returned no row');
  const id = randomUUID();
  await app.db.insert(organizations).values({
    id,
    tenantId: tenant,
    organizationId: id,
    kind,
    name,
    zitadelOrgId: `zitadel-${id}`,
  });
  return { tenantId: tenant, organizationId: id };
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  // Same shape as infra/postgres/init-dbs.sh: plain login roles, a database owned by bos_owner, and default
  // privileges that give bos_app DML on whatever bos_owner creates later.
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  // Default privileges belong to one database, so they are set from inside "bos".
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
  app = createDb(urlFor('bos_app', APP_PW, 'bos'), { max: 2 });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await container?.stop();
});

describe('migrations', () => {
  it('applied 0000 to an empty database', async () => {
    const { rows } = await owner.query<{ table: string }>(
      `SELECT table_schema || '.' || table_name AS "table"
         FROM information_schema.tables
        WHERE table_schema IN ('app', 'ops') ORDER BY 1`,
    );
    expect(rows.map((r) => r.table)).toEqual([
      'app.organizations',
      'app.tenants',
      'ops.restore_canary',
    ]);
  });

  it('can run again without error and without changes (idempotent)', async () => {
    await expect(runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'))).resolves.toBeUndefined();
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
    );
    expect(rows[0]?.n).toBe('1');
  });
});

describe('check-tenancy', () => {
  it('passes on the real schema', async () => {
    await expect(checkTenancy(owner)).resolves.toEqual([]);
    await expect(assertTenancy(owner)).resolves.toBeUndefined();
  });

  // Each fixture is created inside a transaction and rolled back, so it never leaks into other tests.
  async function violationsFor(createTableSql: string) {
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      await client.query(createTableSql);
      const violations = await checkTenancy(client);
      let message = '';
      try {
        await assertTenancy(client);
      } catch (error) {
        message = error instanceof Error ? error.message : '';
      }
      return { violations, message };
    } finally {
      await client.query('ROLLBACK');
      client.release();
    }
  }

  it('fails on a table without tenant_id', async () => {
    const { violations, message } = await violationsFor(
      'CREATE TABLE app.bad_no_tenant (id uuid PRIMARY KEY, organization_id uuid NOT NULL)',
    );
    expect(violations).toEqual([
      { table: 'app.bad_no_tenant', column: 'tenant_id', problem: 'missing' },
    ]);
    expect(message).toContain('app.bad_no_tenant');
  });

  it('fails on a table without organization_id', async () => {
    const { violations, message } = await violationsFor(
      'CREATE TABLE app.bad_no_org (id uuid PRIMARY KEY, tenant_id uuid NOT NULL)',
    );
    expect(violations).toEqual([
      { table: 'app.bad_no_org', column: 'organization_id', problem: 'missing' },
    ]);
    expect(message).toContain('app.bad_no_org');
  });

  it('fails when a column is nullable', async () => {
    const { violations } = await violationsFor(
      'CREATE TABLE app.bad_nullable (id uuid PRIMARY KEY, tenant_id uuid, organization_id uuid NOT NULL)',
    );
    expect(violations).toEqual([
      { table: 'app.bad_nullable', column: 'tenant_id', problem: 'nullable' },
    ]);
  });

  it('fails when a column is not a uuid', async () => {
    const { violations } = await violationsFor(
      'CREATE TABLE app.bad_type (id uuid PRIMARY KEY, tenant_id uuid NOT NULL, organization_id text NOT NULL)',
    );
    expect(violations).toEqual([
      { table: 'app.bad_type', column: 'organization_id', problem: 'not uuid' },
    ]);
  });

  it('sees a table that the checking role has no privileges on', async () => {
    // information_schema would hide this table from bos_app; the check reads pg_catalog and must not.
    // It is committed (a second connection cannot see an open transaction) and dropped again in `finally`.
    try {
      await owner.query('CREATE TABLE app.bad_hidden (id uuid PRIMARY KEY)');
      await owner.query('REVOKE ALL ON app.bad_hidden FROM bos_app');
      const violations = await checkTenancy(app.pool);
      expect(violations.map((v) => v.table)).toContain('app.bad_hidden');
    } finally {
      await owner.query('DROP TABLE IF EXISTS app.bad_hidden');
    }
  });
});

describe('roles', () => {
  it('lets bos_app read and write app tables', async () => {
    const { organizationId } = await insertOrg('staff', 'Techrida');
    const rows = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, organizationId));
    expect(rows).toHaveLength(1);
    await app.db
      .update(organizations)
      .set({ name: 'Techrida 2' })
      .where(eq(organizations.id, organizationId));
    await app.db.delete(organizations).where(eq(organizations.id, organizationId));
  });

  it('lets bos_app insert and read ops.restore_canary but not change or delete it', async () => {
    const [row] = await app.db.insert(restoreCanary).values({}).returning();
    expect(row?.id).toBeDefined();
    await expect(app.pool.query('SELECT 1 FROM ops.restore_canary')).resolves.toBeDefined();
    await expect(
      app.pool.query('UPDATE ops.restore_canary SET written_at = now()'),
    ).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.pool.query('DELETE FROM ops.restore_canary')).rejects.toMatchObject({
      code: '42501',
    });
  });

  it('does not let bos_app change the schema', async () => {
    await expect(app.pool.query('CREATE TABLE app.sneaky (id uuid)')).rejects.toMatchObject({
      code: '42501',
    });
    await expect(app.pool.query('DROP TABLE app.organizations')).rejects.toMatchObject({
      code: '42501',
    });
  });
});

describe('organizations constraints', () => {
  it('fills organization_id from id when an insert leaves it out', async () => {
    const tenant = await app.pool.query<{ id: string }>(
      'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
    );
    const tenantId = tenant.rows[0]?.id;
    const { rows } = await app.pool.query<{ id: string; organization_id: string }>(
      `INSERT INTO app.organizations (tenant_id, kind, name, zitadel_org_id)
       VALUES ($1, 'customer', 'Acme', $2) RETURNING id, organization_id`,
      [tenantId, `zitadel-${randomUUID()}`],
    );
    expect(rows[0]?.organization_id).toBe(rows[0]?.id);
  });

  it('rejects an organization_id that differs from id', async () => {
    const tenant = await app.pool.query<{ id: string }>(
      'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
    );
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, organization_id, kind, name, zitadel_org_id)
         VALUES ($1, gen_random_uuid(), 'customer', 'Acme', $2)`,
        [tenant.rows[0]?.id, `zitadel-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects an unknown kind and a repeated zitadel_org_id', async () => {
    const tenant = await app.pool.query<{ id: string }>(
      'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
    );
    const tenantId = tenant.rows[0]?.id;
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, kind, name, zitadel_org_id) VALUES ($1, 'alien', 'X', $2)`,
        [tenantId, `zitadel-${randomUUID()}`],
      ),
    ).rejects.toMatchObject({ code: '23514' });

    const zitadelOrgId = `zitadel-${randomUUID()}`;
    const insert = `INSERT INTO app.organizations (tenant_id, kind, name, zitadel_org_id) VALUES ($1, 'vendor', 'V', $2)`;
    await app.pool.query(insert, [tenantId, zitadelOrgId]);
    await expect(app.pool.query(insert, [tenantId, zitadelOrgId])).rejects.toMatchObject({
      code: '23505',
    });
  });
});

describe('scoped() against a real database', () => {
  it('only sees and changes rows of its own organization, even inside the same tenant', async () => {
    const a = await insertOrg('customer', 'Org A');
    const b = await insertOrg('customer', 'Org B', a.tenantId);
    const sa = scoped(a);

    const seen = await app.db.select().from(organizations).where(sa.where(organizations));
    expect(seen.map((r) => r.id)).toEqual([a.organizationId]);

    // Targeting B's row by id while scoped to A matches nothing.
    const hit = await app.db
      .update(organizations)
      .set({ name: 'hijacked' })
      .where(sa.where(organizations, eq(organizations.id, b.organizationId)))
      .returning({ id: organizations.id });
    expect(hit).toEqual([]);

    const [untouched] = await app.db
      .select()
      .from(organizations)
      .where(eq(organizations.id, b.organizationId));
    expect(untouched?.name).toBe('Org B');
  });
});
