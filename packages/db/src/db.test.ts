// Integration tests: a real, empty postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/db test
//
// The container starts with only a superuser, so beforeAll creates the same roles and default privileges that
// infra/postgres/init-dbs.sh creates in the real stack, then migrates as bos_owner and queries as bos_app.
// That way the tests walk the same path as production: owner migrates, app role does the daily work.
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { eq } from 'drizzle-orm';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { assertTenancy, checkTenancy } from './check-tenancy.js';
import { createDb, type DbHandle } from './client.js';
import { runMigrations } from './migrate.js';
import { organizations, restoreCanary, tenants } from './schema/platform.js';
import { scoped } from './scoped.js';
import { createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let admin: Pool;
let owner: Pool;
let app: DbHandle;

/** Inserts a tenant and one organization, a legal entity (as bos_app), and returns their ids. */
async function insertOrg(name: string, tenantId?: string) {
  const tenant =
    tenantId ?? (await app.db.insert(tenants).values({}).returning({ id: tenants.id }))[0]?.id;
  if (tenant === undefined) throw new Error('tenant insert returned no row');
  const id = randomUUID();
  await app.db.insert(organizations).values({
    id,
    tenantId: tenant,
    organizationId: id,
    code: `E-${id}`,
    name,
    legalName: name,
  });
  return { tenantId: tenant, organizationId: id };
}

/**
 * Runs fn in one transaction as bos_app with bos.organization_id set. A write to a tenant-scoped table (idp_orgs,
 * parties) has no organization_id of its own, so the audit trigger takes the acting entity from this setting.
 */
async function inEntityTx<T>(
  organizationId: string,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await app.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SELECT set_config('bos.organization_id', $1, true)`, [organizationId]);
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

/** How many migrations the journal lists; every one must be recorded after a migrate. */
function journalEntryCount(): number {
  const journal = JSON.parse(
    readFileSync(new URL('../migrations/meta/_journal.json', import.meta.url), 'utf8'),
  ) as { entries: unknown[] };
  return journal.entries.length;
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // privileges that give bos_app DML on whatever bos_owner creates later.
  await admin.end();

  // Default privileges belong to one database, so they are set from inside "bos".
  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // P1's audit trigger (0001) refuses a write to an app table with no actor. These P0 tests write rows
  // directly as bos_app, so every bos_app session in THIS test database gets a test actor by default.
  // The API never relies on this: withTx sets the actor per transaction (see packages/db/src/audit.test.ts
  // for the test that a write without one raises).
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:db-test'],
    ['bos.correlation_id', 'db-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = createDb(testDb.appUrl, { max: 2 });
});

afterAll(async () => {
  await app?.close();
  await owner?.end();
  await testDb?.drop();
});

describe('migrations', () => {
  it('applied the P0 tables (0000) alongside the P1 kernel migrations', async () => {
    const { rows } = await owner.query<{ table: string }>(
      `SELECT table_schema || '.' || table_name AS "table"
         FROM information_schema.tables
        WHERE table_schema IN ('app', 'ops') ORDER BY 1`,
    );
    // P1 (0001-0007) adds more tables; each kernel unit's own test checks those in detail.
    expect(rows.map((r) => r.table)).toEqual(
      expect.arrayContaining(['app.organizations', 'app.tenants', 'ops.restore_canary']),
    );
  });

  it('can run again without error and without changes (idempotent)', async () => {
    await expect(runMigrations(testDb.ownerUrl)).resolves.toBeUndefined();
    const { rows } = await owner.query<{ n: string }>(
      'SELECT count(*) AS n FROM drizzle.__drizzle_migrations',
    );
    // One row per journal entry, so the count follows the journal instead of a hard-coded number.
    expect(rows[0]?.n).toBe(String(journalEntryCount()));
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
      'CREATE TABLE app.bad_no_org (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id))',
    );
    expect(violations).toEqual([
      { table: 'app.bad_no_org', column: 'organization_id', problem: 'missing' },
    ]);
    expect(message).toContain('app.bad_no_org');
  });

  // checkTenancy() is strict by default (ADR 0027): besides the two columns, a table with tenant_id needs the
  // foreign key to app.tenants (rule 1) and, with organization_id, the composite foreign key to
  // app.organizations (rule 2). The fixtures below carry both, so each case isolates the one problem it tests.
  const GOOD_KEYS =
    'FOREIGN KEY (tenant_id) REFERENCES app.tenants (id), FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations (tenant_id, id)';

  it('fails when a column is nullable', async () => {
    const { violations } = await violationsFor(
      `CREATE TABLE app.bad_nullable (id uuid PRIMARY KEY, tenant_id uuid, organization_id uuid NOT NULL, ${GOOD_KEYS})`,
    );
    expect(violations).toEqual([
      { table: 'app.bad_nullable', column: 'tenant_id', problem: 'nullable' },
    ]);
  });

  it('fails when a column is not a uuid', async () => {
    // A text organization_id cannot reference organizations (id), so the strict rule 2 reports the missing
    // foreign key as well: that is the same fault seen twice, not a second problem. The tenant key stays valid.
    const { violations } = await violationsFor(
      'CREATE TABLE app.bad_type (id uuid PRIMARY KEY, tenant_id uuid NOT NULL REFERENCES app.tenants (id), organization_id text NOT NULL)',
    );
    expect(violations).toEqual([
      { table: 'app.bad_type', column: 'organization_id', problem: 'not uuid' },
      {
        table: 'app.bad_type',
        column: 'organization_id',
        problem: 'no foreign key to app.organizations from organization_id',
      },
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
    const { organizationId } = await insertOrg('Techrida');
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
      `INSERT INTO app.organizations (tenant_id, code, name, legal_name)
       VALUES ($1, 'ACME', 'Acme', 'Acme Ltd') RETURNING id, organization_id`,
      [tenantId],
    );
    expect(rows[0]?.organization_id).toBe(rows[0]?.id);
  });

  it('rejects an organization_id that differs from id', async () => {
    const tenant = await app.pool.query<{ id: string }>(
      'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
    );
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, organization_id, code, name, legal_name)
         VALUES ($1, gen_random_uuid(), 'ACME', 'Acme', 'Acme Ltd')`,
        [tenant.rows[0]?.id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // ADR 0027 removed organizations.kind and organizations.zitadel_org_id, and with them the old checks "an unknown
  // kind is refused" and "a zitadel_org_id is unique". The same two rules now live on idp_orgs
  // (idp_orgs_kind_check, idp_orgs_zitadel_org_id_unique); the organizations table has two new ones, below.
  it('has no kind and no zitadel_org_id column any more', async () => {
    const { rows } = await owner.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'app' AND table_name = 'organizations'`,
    );
    const columns = rows.map((r) => r.column_name);
    expect(columns).not.toContain('kind');
    expect(columns).not.toContain('zitadel_org_id');
    expect(columns).toEqual(expect.arrayContaining(['code', 'legal_name', 'is_default']));
  });

  it('rejects an unknown IdP org kind (idp_orgs_kind_check, was organizations_kind_check)', async () => {
    const { tenantId, organizationId } = await createTenantWithEntity(app.pool);
    await expect(
      inEntityTx(organizationId, (c) =>
        c.query(
          `INSERT INTO app.idp_orgs (tenant_id, zitadel_org_id, kind, name) VALUES ($1, $2, 'alien', 'X')`,
          [tenantId, `zitadel-${randomUUID()}`],
        ),
      ),
    ).rejects.toMatchObject({ code: '23514', constraint: 'idp_orgs_kind_check' });
  });

  it('rejects a repeated zitadel_org_id, even across tenants (idp_orgs_zitadel_org_id_unique)', async () => {
    const a = await createTenantWithEntity(app.pool);
    const b = await createTenantWithEntity(app.pool);
    const { rows } = await owner.query<{ zitadel_org_id: string }>(
      'SELECT zitadel_org_id FROM app.idp_orgs WHERE tenant_id = $1',
      [a.tenantId],
    );
    // The login looks the org up before it knows the tenant, so the id is global. Tenant b's staff IdP org is
    // replaced by one that reuses tenant a's id; b has no staff org of its own to clash with after the delete.
    await expect(
      inEntityTx(b.organizationId, async (c) => {
        await c.query('DELETE FROM app.idp_orgs WHERE tenant_id = $1', [b.tenantId]);
        await c.query(
          `INSERT INTO app.idp_orgs (tenant_id, zitadel_org_id, kind, name) VALUES ($1, $2, 'staff', 'B')`,
          [b.tenantId, rows[0]?.zitadel_org_id],
        );
      }),
    ).rejects.toMatchObject({ code: '23505', constraint: 'idp_orgs_zitadel_org_id_unique' });
  });

  it('rejects a repeated code within a tenant (organizations_tenant_code_unique)', async () => {
    const { tenantId, organizationId } = await createTenantWithEntity(app.pool, { code: 'TR' });
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, code, name, legal_name) VALUES ($1, 'TR', 'Other', 'Other Ltd')`,
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'organizations_tenant_code_unique' });
    // The same code is free in another tenant.
    const other = await createTenantWithEntity(app.pool, { code: 'TR' });
    expect(other.organizationId).not.toBe(organizationId);
  });

  it('allows one default entity per tenant (organizations_tenant_default_unique)', async () => {
    const { tenantId } = await createTenantWithEntity(app.pool);
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, code, name, legal_name, is_default)
         VALUES ($1, 'SECOND', 'Second', 'Second Ltd', true)`,
        [tenantId],
      ),
    ).rejects.toMatchObject({ code: '23505', constraint: 'organizations_tenant_default_unique' });
    // A non-default second entity is fine.
    await expect(
      app.pool.query(
        `INSERT INTO app.organizations (tenant_id, code, name, legal_name) VALUES ($1, 'SECOND', 'Second', 'Second Ltd')`,
        [tenantId],
      ),
    ).resolves.toBeDefined();
  });
});

describe('scoped() against a real database', () => {
  it('only sees and changes rows of its own organization, even inside the same tenant', async () => {
    const a = await insertOrg('Org A');
    const b = await insertOrg('Org B', a.tenantId);
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
