// Integration tests for the first half of migration 0013_legal_entities (ADR 0027 sections 2, 3 and 6) on a
// real postgres:16-alpine (Testcontainers, needs Docker).
// Run with: pnpm --filter @bos/db exec vitest run src/entities.test.ts
//
//   * The new tables parties, idp_orgs and user_entities, with their keys, CHECKs and FKs, read from
//     pg_catalog, and the new columns of organizations.
//   * The audit fallback: capture_row takes organization_id from the row, else from bos.organization_id, and
//     raises when both are missing. attach() requires only tenant_id.
//   * The organizations backfill, on a database migrated to 0012 that already holds rows.
//
// Each database is a copy from createTestDatabase() (roles and the default privileges of init-dbs.sh).
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;
/** The per-case databases, dropped in afterAll. */
const caseDatabases: TestDatabase[] = [];

/** A database owned by bos_owner with init-dbs.sh's default privileges, not yet migrated: its owner URL. */
async function createDatabase(): Promise<string> {
  const db = await createTestDatabase({ migrated: false });
  caseDatabases.push(db);
  return db.ownerUrl;
}

/** The bos.* settings withTx() sets, for one transaction. organizationId null leaves it out. */
function settingsFor(
  tenantId: string,
  organizationId: string | null,
  over: Record<string, string> = {},
): Record<string, string> {
  return {
    'bos.tenant_id': tenantId,
    ...(organizationId === null ? {} : { 'bos.organization_id': organizationId }),
    'bos.actor_kind': 'system',
    'bos.actor_id': 'entities-test',
    'bos.correlation_id': randomUUID(),
    'bos.ip': '',
    'bos.user_agent': '',
    ...over,
  };
}

/** Runs fn in one transaction on `pool`, after set_config(..., true) of each setting (like withTx). */
async function inTx<T>(
  pool: Pool,
  settings: Record<string, string>,
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const [key, value] of Object.entries(settings)) {
      await c.query('SELECT set_config($1, $2, true)', [key, value]);
    }
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

/** Constraint definitions of app.<table>, by name (pg_get_constraintdef). */
async function constraintsOf(table: string): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ conname: string; def: string }>(
    `SELECT c.conname, pg_get_constraintdef(c.oid) AS def
       FROM pg_catalog.pg_constraint c
      WHERE c.conrelid = ('app.' || $1)::regclass`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.conname, r.def]));
}

/** Index definitions of app.<table>, by name (pg_get_indexdef). */
async function indexesOf(table: string): Promise<Record<string, string>> {
  const { rows } = await owner.query<{ relname: string; def: string }>(
    `SELECT ic.relname, pg_get_indexdef(i.indexrelid) AS def
       FROM pg_catalog.pg_index i
       JOIN pg_catalog.pg_class ic ON ic.oid = i.indexrelid
      WHERE i.indrelid = ('app.' || $1)::regclass`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.relname, r.def]));
}

/** Columns of app.<table>: type and NOT NULL, by name. */
async function columnsOf(
  table: string,
): Promise<Record<string, { type: string; notNull: boolean }>> {
  const { rows } = await owner.query<{ attname: string; type: string; attnotnull: boolean }>(
    `SELECT a.attname, format_type(a.atttypid, a.atttypmod) AS type, a.attnotnull
       FROM pg_catalog.pg_attribute a
      WHERE a.attrelid = ('app.' || $1)::regclass AND a.attnum > 0 AND NOT a.attisdropped`,
    [table],
  );
  return Object.fromEntries(rows.map((r) => [r.attname, { type: r.type, notNull: r.attnotnull }]));
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 5 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
  for (const db of caseDatabases) await db.drop();
});

describe('0013 tables and keys (pg_catalog)', () => {
  it('creates parties with its kind CHECK and both unique keys', async () => {
    const cols = await columnsOf('parties');
    expect(Object.keys(cols).sort()).toEqual(
      ['code', 'created_at', 'id', 'kind', 'name', 'tenant_id', 'updated_at'].sort(),
    );
    expect(cols['organization_id']).toBeUndefined();
    const cons = await constraintsOf('parties');
    expect(cons['parties_kind_check']).toMatch(/'customer'.*'vendor'/);
    expect(cons['parties_tenant_code_unique']).toBe('UNIQUE (tenant_id, code)');
    expect(cons['parties_tenant_id_kind_unique']).toBe('UNIQUE (tenant_id, id, kind)');
    expect(cons['parties_tenant_id_tenants_id_fk']).toBe(
      'FOREIGN KEY (tenant_id) REFERENCES app.tenants(id)',
    );
  });

  it('creates idp_orgs with the staff/party CHECK, the staff partial unique and the kind FK', async () => {
    const cols = await columnsOf('idp_orgs');
    expect(cols['organization_id']).toBeUndefined();
    expect(cols['party_id']).toEqual({ type: 'uuid', notNull: false });
    expect(cols['zitadel_org_id']?.notNull).toBe(true);
    const cons = await constraintsOf('idp_orgs');
    expect(cons['idp_orgs_kind_check']).toMatch(/'staff'.*'customer'.*'vendor'/);
    expect(cons['idp_orgs_party_check']).toBe(
      "CHECK (((kind = 'staff'::text) = (party_id IS NULL)))",
    );
    expect(cons['idp_orgs_zitadel_org_id_unique']).toBe('UNIQUE (zitadel_org_id)');
    expect(cons['idp_orgs_tenant_party_unique']).toBe('UNIQUE (tenant_id, party_id)');
    expect(cons['idp_orgs_tenant_id_unique']).toBe('UNIQUE (tenant_id, id)');
    expect(cons['idp_orgs_tenant_party_kind_fk']).toBe(
      'FOREIGN KEY (tenant_id, party_id, kind) REFERENCES app.parties(tenant_id, id, kind)',
    );
    const idx = await indexesOf('idp_orgs');
    expect(idx['idp_orgs_tenant_staff_unique']).toMatch(
      /^CREATE UNIQUE INDEX .* \(tenant_id\) WHERE \(kind = 'staff'::text\)$/,
    );
  });

  it('creates user_entities with its unique keys and composite FKs, and the parent keys they need', async () => {
    const cols = await columnsOf('user_entities');
    expect(cols['role_keys']).toEqual({ type: 'text[]', notNull: false });
    expect(cols['department_id']).toEqual({ type: 'uuid', notNull: false });
    expect(cols['is_default']).toEqual({ type: 'boolean', notNull: true });
    const cons = await constraintsOf('user_entities');
    expect(cons['user_entities_tenant_org_user_unique']).toBe(
      'UNIQUE (tenant_id, organization_id, user_id)',
    );
    expect(cons['user_entities_tenant_org_fk']).toBe(
      'FOREIGN KEY (tenant_id, organization_id) REFERENCES app.organizations(tenant_id, id)',
    );
    expect(cons['user_entities_tenant_user_fk']).toBe(
      'FOREIGN KEY (tenant_id, user_id) REFERENCES app.users(tenant_id, id)',
    );
    expect(cons['user_entities_tenant_org_department_fk']).toBe(
      'FOREIGN KEY (tenant_id, organization_id, department_id) REFERENCES app.departments(tenant_id, organization_id, id)',
    );
    const idx = await indexesOf('user_entities');
    expect(idx['user_entities_tenant_user_default_unique']).toMatch(
      /^CREATE UNIQUE INDEX .* \(tenant_id, user_id\) WHERE is_default$/,
    );
    expect(idx['user_entities_tenant_user_idx']).toMatch(
      /^CREATE INDEX .* \(tenant_id, user_id\)$/,
    );
    expect((await constraintsOf('organizations'))['organizations_tenant_id_unique']).toBe(
      'UNIQUE (tenant_id, id)',
    );
    expect((await constraintsOf('users'))['users_tenant_id_unique']).toBe('UNIQUE (tenant_id, id)');
    const departments = await constraintsOf('departments');
    expect(departments['departments_tenant_id_unique']).toBe('UNIQUE (tenant_id, id)');
    expect(departments['departments_tenant_org_id_unique']).toBe(
      'UNIQUE (tenant_id, organization_id, id)',
    );
  });

  it('adds code, legal_name and is_default to organizations, NOT NULL, with their uniques', async () => {
    const cols = await columnsOf('organizations');
    expect(cols['code']).toEqual({ type: 'text', notNull: true });
    expect(cols['legal_name']).toEqual({ type: 'text', notNull: true });
    expect(cols['is_default']).toEqual({ type: 'boolean', notNull: true });
    // The second half (U1b) drops kind and zitadel_org_id with their constraints.
    expect(cols['kind']).toBeUndefined();
    expect(cols['zitadel_org_id']).toBeUndefined();
    const cons = await constraintsOf('organizations');
    expect(cons['organizations_kind_check']).toBeUndefined();
    expect(cons['organizations_zitadel_org_id_unique']).toBeUndefined();
    expect(cons['organizations_tenant_code_unique']).toBe('UNIQUE (tenant_id, code)');
    const idx = await indexesOf('organizations');
    expect(idx['organizations_tenant_default_unique']).toMatch(
      /^CREATE UNIQUE INDEX .* \(tenant_id\) WHERE is_default$/,
    );
  });

  it('re-keys users, user_roles, role_permissions, authz_versions, fx_rates and test_memos (U1b)', async () => {
    for (const table of ['users', 'user_roles', 'role_permissions', 'authz_versions', 'fx_rates']) {
      expect((await columnsOf(table))['organization_id'], table).toBeUndefined();
    }
    const userCols = await columnsOf('users');
    expect(userCols['idp_org_id']).toEqual({ type: 'uuid', notNull: true });
    expect(userCols['department_id']).toBeUndefined();
    // 0014 makes it composite, so a user can never point at another tenant's IdP org.
    expect((await constraintsOf('users'))['users_idp_org_fk']).toBe(
      'FOREIGN KEY (tenant_id, idp_org_id) REFERENCES app.idp_orgs(tenant_id, id)',
    );
    const userIdx = await indexesOf('users');
    expect(userIdx['users_tenant_status_idx']).toMatch(/\(tenant_id, status\)$/);
    expect(userIdx['users_tenant_idp_org_idx']).toMatch(/\(tenant_id, idp_org_id\)$/);
    expect(userIdx['users_tenant_org_status_idx']).toBeUndefined();
    expect(userIdx['users_tenant_org_department_idx']).toBeUndefined();

    const userRoles = await constraintsOf('user_roles');
    expect(userRoles['user_roles_tenant_id_user_id_role_key_pk']).toBe(
      'PRIMARY KEY (tenant_id, user_id, role_key)',
    );
    expect(userRoles['user_roles_user_id_role_key_pk']).toBeUndefined();
    expect(userRoles['user_roles_id_unique']).toBe('UNIQUE (id)');
    const userRolesIdx = await indexesOf('user_roles');
    expect(userRolesIdx['user_roles_tenant_role_idx']).toMatch(/\(tenant_id, role_key\)$/);
    expect(userRolesIdx['user_roles_tenant_org_role_idx']).toBeUndefined();

    expect(
      (await constraintsOf('role_permissions'))['role_permissions_tenant_role_permission_unique'],
    ).toBe('UNIQUE (tenant_id, role_key, permission)');
    expect((await constraintsOf('authz_versions'))['authz_versions_tenant_unique']).toBe(
      'UNIQUE (tenant_id)',
    );
    expect((await constraintsOf('fx_rates'))['fx_rates_tenant_currency_date_unique']).toBe(
      'UNIQUE (tenant_id, currency, rate_date)',
    );

    const memoCols = await columnsOf('test_memos');
    expect(memoCols['customer_organization_id']).toBeUndefined();
    expect(memoCols['customer_party_id']).toEqual({ type: 'uuid', notNull: false });
    expect(memoCols['customer_party_kind']).toEqual({ type: 'text', notNull: false });
    const memoCons = await constraintsOf('test_memos');
    expect(memoCons['test_memos_customer_party_fk']).toBe(
      'FOREIGN KEY (tenant_id, customer_party_id, customer_party_kind) REFERENCES app.parties(tenant_id, id, kind)',
    );
    expect(memoCons['test_memos_customer_organization_id_organizations_id_fk']).toBeUndefined();
    const memoIdx = await indexesOf('test_memos');
    expect(memoIdx['test_memos_tenant_customer_party_idx']).toMatch(
      /\(tenant_id, customer_party_id\)$/,
    );
    const { rows } = await owner.query(
      `SELECT 1 FROM pg_catalog.pg_proc WHERE proname = 'assert_org_kind'
        UNION ALL
       SELECT 1 FROM pg_catalog.pg_trigger WHERE tgname = 'test_memos_assert_customer_kind'`,
    );
    expect(rows).toHaveLength(0);
  });

  it('attaches the audit trigger to the three new tables', async () => {
    const { rows } = await owner.query<{ relname: string }>(
      `SELECT c.relname FROM pg_catalog.pg_trigger t JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
        WHERE t.tgname = 'audit_capture' AND c.relname IN ('parties', 'idp_orgs', 'user_entities')
        ORDER BY c.relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual(['idp_orgs', 'parties', 'user_entities']);
  });

  it('keeps the 0008 conventions on capture_row and attach: definer, pg_temp last, no PUBLIC or bos_app EXECUTE', async () => {
    const { rows } = await owner.query<{
      proname: string;
      prosecdef: boolean;
      proconfig: string[] | null;
      app_exec: boolean;
      public_exec: boolean;
    }>(
      `SELECT p.proname, p.prosecdef, p.proconfig,
              has_function_privilege('bos_app', p.oid, 'EXECUTE') AS app_exec,
              EXISTS (
                SELECT 1 FROM aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                 WHERE a.grantee = 0 AND a.privilege_type = 'EXECUTE') AS public_exec
         FROM pg_catalog.pg_proc p JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname = 'audit' AND p.proname IN ('capture_row', 'attach')
        ORDER BY p.proname`,
    );
    expect(rows.map((r) => r.proname)).toEqual(['attach', 'capture_row']);
    for (const r of rows) {
      expect(r.prosecdef).toBe(true);
      expect(r.proconfig).toEqual(['search_path=pg_catalog, audit, app, pg_temp']);
      expect(r.app_exec).toBe(false);
      expect(r.public_exec).toBe(false);
    }
  });
});

describe('audit fallback for tenant-scoped tables', () => {
  // A tenant-scoped table: tenant_id, no organization_id. Created by the owner, attached outside any expect,
  // so on the old attach() this setup itself fails (no such column(s): organization_id).
  async function withFixture(fn: () => Promise<void>): Promise<void> {
    await owner.query(`CREATE TABLE app.entities_fixture (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      name text NOT NULL)`);
    try {
      await owner.query(`SELECT audit.attach('app.entities_fixture')`);
      await fn();
    } finally {
      await owner.query('DROP TABLE IF EXISTS app.entities_fixture');
    }
  }

  const insert = (c: PoolClient, tenantId: string) =>
    c.query(`INSERT INTO app.entities_fixture (tenant_id, name) VALUES ($1, 'x')`, [tenantId]);

  it('captures a row without organization_id under bos.organization_id', async () => {
    await withFixture(async () => {
      const tenantId = randomUUID();
      const entityId = randomUUID();
      await inTx(app, settingsFor(tenantId, entityId), (c) => insert(c, tenantId));
      const { rows } = await owner.query<{ organization_id: string; action: string }>(
        'SELECT organization_id, action FROM audit.audit_events WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows).toEqual([{ organization_id: entityId, action: 'entities_fixture.insert' }]);
    });
  });

  it('raises when the row has no organization_id and bos.organization_id is unset or empty', async () => {
    await withFixture(async () => {
      const tenantId = randomUUID();
      await expect(
        inTx(app, settingsFor(tenantId, null), (c) => insert(c, tenantId)),
      ).rejects.toThrow(/entities_fixture.*bos\.organization_id/);
      // A pooled connection reads '' once set_config has touched the setting.
      await expect(
        inTx(app, settingsFor(tenantId, ''), (c) => insert(c, tenantId)),
      ).rejects.toThrow(/entities_fixture.*bos\.organization_id/);
      const { rows } = await owner.query('SELECT 1 FROM audit.audit_events WHERE tenant_id = $1', [
        tenantId,
      ]);
      expect(rows).toHaveLength(0);
    });
  });

  it('still prefers the row organization_id over bos.organization_id', async () => {
    const tenantId = randomUUID();
    const rowEntity = randomUUID();
    await owner.query(`CREATE TABLE app.entities_fixture_owned (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      tenant_id uuid NOT NULL,
      organization_id uuid NOT NULL)`);
    try {
      await owner.query(`SELECT audit.attach('app.entities_fixture_owned')`);
      await inTx(app, settingsFor(tenantId, randomUUID()), (c) =>
        c.query(
          'INSERT INTO app.entities_fixture_owned (tenant_id, organization_id) VALUES ($1, $2)',
          [tenantId, rowEntity],
        ),
      );
      const { rows } = await owner.query<{ organization_id: string }>(
        'SELECT organization_id FROM audit.audit_events WHERE tenant_id = $1',
        [tenantId],
      );
      expect(rows).toEqual([{ organization_id: rowEntity }]);
    } finally {
      await owner.query('DROP TABLE IF EXISTS app.entities_fixture_owned');
    }
  });
});

describe('idp_orgs kind rules', () => {
  it('accepts a customer party behind a customer org and refuses a vendor party or a staff org with a party', async () => {
    const tenantId = randomUUID();
    const entityId = randomUUID();
    await owner.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
    const s = settingsFor(tenantId, entityId);

    const [customer, vendor] = await inTx(app, s, async (c) => {
      const { rows } = await c.query<{ id: string }>(
        `INSERT INTO app.parties (tenant_id, kind, code, name)
         VALUES ($1, 'customer', 'CUST-1', 'Customer'), ($1, 'vendor', 'VEND-1', 'Vendor')
         RETURNING id`,
        [tenantId],
      );
      return [rows[0]?.id, rows[1]?.id];
    });

    const idpOrg = (kind: string, partyId: string | null) =>
      inTx(app, s, (c) =>
        c.query(
          `INSERT INTO app.idp_orgs (tenant_id, zitadel_org_id, kind, party_id, name)
           VALUES ($1, $2, $3, $4, 'IdP org')`,
          [tenantId, randomUUID(), kind, partyId],
        ),
      );

    // Positive control: the right kind passes, so the refusals below are the rules, not a setup error.
    await expect(idpOrg('customer', customer ?? null)).resolves.toBeDefined();
    await expect(idpOrg('staff', null)).resolves.toBeDefined();

    await expect(idpOrg('customer', vendor ?? null)).rejects.toMatchObject({
      code: '23503',
      constraint: 'idp_orgs_tenant_party_kind_fk',
    });
    await expect(idpOrg('staff', customer ?? null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'idp_orgs_party_check',
    });
    await expect(idpOrg('vendor', null)).rejects.toMatchObject({
      code: '23514',
      constraint: 'idp_orgs_party_check',
    });

    // The tenant-scoped rows were audited under the acting entity (the section 6 fallback).
    const { rows } = await owner.query<{ organization_id: string }>(
      'SELECT DISTINCT organization_id FROM audit.audit_events WHERE tenant_id = $1',
      [tenantId],
    );
    expect(rows).toEqual([{ organization_id: entityId }]);
  });
});

describe('organizations backfill on a database that already has rows', () => {
  it('fills code and legal_name, sets NOT NULL, and makes the one staff org per tenant the default', async () => {
    const ownerUrl = await createDatabase();

    // Migrate to 0012 only: a copy of the folder with the journal cut there.
    const folder = mkdtempSync(join(tmpdir(), 'bos-0012-'));
    try {
      cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
      const journalPath = join(folder, 'meta', '_journal.json');
      const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
        entries: { idx: number }[];
      };
      journal.entries = journal.entries.filter((e) => e.idx <= 12);
      writeFileSync(journalPath, JSON.stringify(journal));
      const { db, close } = createDb(ownerUrl, { max: 1 });
      try {
        await migrate(db, { migrationsFolder: folder });
      } finally {
        await close();
      }
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const pool = new Pool({ connectionString: ownerUrl, max: 1 });
    try {
      const tenantId = randomUUID();
      const staffId = randomUUID();
      const customerId = randomUUID();
      await pool.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
      await inTx(pool, settingsFor(tenantId, staffId), (c) =>
        c.query(
          `INSERT INTO app.organizations (id, tenant_id, kind, name, zitadel_org_id)
           VALUES ($1, $3, 'staff', 'Techrida', 'z-staff'), ($2, $3, 'customer', 'Techrida', 'z-cust')`,
          [staffId, customerId, tenantId],
        ),
      );

      await runMigrations(ownerUrl);

      const { rows } = await pool.query<{
        id: string;
        code: string;
        legal_name: string;
        is_default: boolean;
      }>('SELECT id, code, legal_name, is_default FROM app.organizations WHERE tenant_id = $1', [
        tenantId,
      ]);
      // The second half (U1b) turns the customer into a party with the same uuid and gives the default
      // entity the seed's code TR and legal name.
      expect(rows).toEqual([
        { id: staffId, code: 'TR', legal_name: 'Techrida Pvt. Ltd.', is_default: true },
      ]);
      const party = await pool.query<{ id: string; code: string }>(
        'SELECT id, code FROM app.parties WHERE tenant_id = $1',
        [tenantId],
      );
      expect(party.rows).toHaveLength(1);
      expect(party.rows[0]?.id).toBe(customerId);
      // The same name still gave the backfill a non-empty code that is distinct from the staff org's.
      expect(party.rows[0]?.code.length).toBeGreaterThan(0);
      expect(party.rows[0]?.code).not.toBe('TR');

      // The backfill UPDATE was audited under the migration's actor.
      const audit = await pool.query<{ actor_id: string }>(
        `SELECT DISTINCT actor_id FROM audit.audit_events
          WHERE tenant_id = $1 AND action = 'organizations.update'`,
        [tenantId],
      );
      expect(audit.rows).toEqual([{ actor_id: 'system:migration-0013' }]);
    } finally {
      await pool.end();
    }
  });
});

/** Migrates a fresh database (createDatabase) to 0012 only: a copy of the folder with the journal cut there. */
async function migrateTo0012(ownerUrl: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bos-0012-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { idx: number }[];
    };
    journal.entries = journal.entries.filter((e) => e.idx <= 12);
    writeFileSync(journalPath, JSON.stringify(journal));
    const { db, close } = createDb(ownerUrl, { max: 1 });
    try {
      await migrate(db, { migrationsFolder: folder });
    } finally {
      await close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

/** A test_memos row, naming the customer in customer_organization_id (0012) or customer_party_id (later). */
function insertMemo(
  c: PoolClient,
  row: {
    tenantId: string;
    organizationId: string;
    ownerUserId: string;
    customerColumn: 'customer_organization_id' | 'customer_party_id';
    customerId: string;
  },
) {
  return c.query<{ id: string }>(
    `INSERT INTO app.test_memos (tenant_id, organization_id, number, title, body, amount, currency, amount_npr,
       fx_rate, fx_source, fx_date, owner_user_id, ${row.customerColumn})
     VALUES ($1, $2, $3, 'Memo', 'Body', 10, 'NPR', 10, 1, 'peg', '2026-11-01', $4, $5)
     RETURNING id`,
    [row.tenantId, row.organizationId, randomUUID(), row.ownerUserId, row.customerId],
  );
}

describe('0013 data move on a database that already has rows (K1-U1b)', () => {
  const tenantId = randomUUID();
  const staffId = randomUUID();
  const customerId = randomUUID();
  const vendorId = randomUUID();
  const departmentId = randomUUID();
  const staffUserId = randomUUID();
  const portalUserId = randomUUID();
  const zStaff = `z-staff-${randomUUID()}`;
  const zCustomer = `z-cust-${randomUUID()}`;
  const zVendor = `z-vend-${randomUUID()}`;
  let memoId: string | undefined;
  let notificationId: string | undefined;
  let pool: Pool;

  beforeAll(async () => {
    const ownerUrl = await createDatabase();
    await migrateTo0012(ownerUrl);
    pool = new Pool({ connectionString: ownerUrl, max: 1 });

    await pool.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
    await inTx(pool, settingsFor(tenantId, staffId), async (c) => {
      await c.query(
        `INSERT INTO app.organizations (id, tenant_id, kind, name, zitadel_org_id)
         VALUES ($1, $4, 'staff', 'Techrida', $5), ($2, $4, 'customer', 'Dev Customer Co', $6),
                ($3, $4, 'vendor', 'Dev Vendor Co', $7)`,
        [staffId, customerId, vendorId, tenantId, zStaff, zCustomer, zVendor],
      );
      await c.query(
        `INSERT INTO app.departments (id, tenant_id, organization_id, name) VALUES ($1, $2, $3, 'Finance')`,
        [departmentId, tenantId, staffId],
      );
      await c.query(
        `INSERT INTO app.users (id, tenant_id, organization_id, zitadel_user_id, status, department_id)
         VALUES ($1, $2, $3, $4, 'active', $5), ($6, $2, $7, $8, 'active', NULL)`,
        [
          staffUserId,
          tenantId,
          staffId,
          `u-staff-${randomUUID()}`,
          departmentId,
          portalUserId,
          customerId,
          `u-portal-${randomUUID()}`,
        ],
      );
      await c.query(
        `INSERT INTO app.user_roles (tenant_id, organization_id, user_id, role_key)
         VALUES ($1, $2, $3, 'finance'), ($1, $4, $5, 'portal')`,
        [tenantId, staffId, staffUserId, customerId, portalUserId],
      );
      // The same (role, permission) in two orgs collides on the new tenant key; the staff row must win.
      await c.query(
        `INSERT INTO app.role_permissions (tenant_id, organization_id, role_key, permission, scope)
         VALUES ($1, $3, 'finance', 'memo.read', 'customer_org'), ($1, $2, 'finance', 'memo.read', 'all'),
                ($1, $3, 'portal', 'memo.read', 'customer_org')`,
        [tenantId, staffId, customerId],
      );
      await c.query(
        `INSERT INTO app.authz_versions (tenant_id, organization_id, version) VALUES ($1, $2, 5), ($1, $3, 9)`,
        [tenantId, staffId, customerId],
      );
      const memo = await insertMemo(c, {
        tenantId,
        organizationId: staffId,
        ownerUserId: staffUserId,
        customerColumn: 'customer_organization_id',
        customerId,
      });
      memoId = memo.rows[0]?.id;
      const notification = await c.query<{ id: string }>(
        `INSERT INTO app.notifications (tenant_id, organization_id, user_id, title, body, link, dedupe_key)
         VALUES ($1, $2, $3, 'Hi', 'Body', '/x', 'k1') RETURNING id`,
        [tenantId, customerId, portalUserId],
      );
      notificationId = notification.rows[0]?.id;
    });

    await runMigrations(ownerUrl);
  });

  afterAll(async () => {
    await pool?.end();
  });

  it('turns customer and vendor orgs into same-uuid parties and leaves only the entity, coded TR', async () => {
    const parties = await pool.query<{ id: string; kind: string }>(
      'SELECT id, kind FROM app.parties WHERE tenant_id = $1 ORDER BY kind',
      [tenantId],
    );
    expect(parties.rows).toEqual([
      { id: customerId, kind: 'customer' },
      { id: vendorId, kind: 'vendor' },
    ]);
    const orgs = await pool.query(
      'SELECT id, code, legal_name, is_default FROM app.organizations WHERE tenant_id = $1',
      [tenantId],
    );
    expect(orgs.rows).toEqual([
      { id: staffId, code: 'TR', legal_name: 'Techrida Pvt. Ltd.', is_default: true },
    ]);
  });

  it('creates an idp_orgs row per former org and points the users at them', async () => {
    const idp = await pool.query<{
      id: string;
      zitadel_org_id: string;
      kind: string;
      party_id: string | null;
    }>('SELECT id, zitadel_org_id, kind, party_id FROM app.idp_orgs WHERE tenant_id = $1', [
      tenantId,
    ]);
    const byZitadel = Object.fromEntries(idp.rows.map((r) => [r.zitadel_org_id, r]));
    expect(idp.rows).toHaveLength(3);
    expect(byZitadel[zStaff]).toMatchObject({ kind: 'staff', party_id: null });
    expect(byZitadel[zCustomer]).toMatchObject({ kind: 'customer', party_id: customerId });
    expect(byZitadel[zVendor]).toMatchObject({ kind: 'vendor', party_id: vendorId });

    const users = await pool.query<{ id: string; idp_org_id: string }>(
      'SELECT id, idp_org_id FROM app.users WHERE tenant_id = $1',
      [tenantId],
    );
    const idpOf = Object.fromEntries(users.rows.map((r) => [r.id, r.idp_org_id]));
    expect(idpOf[staffUserId]).toBe(byZitadel[zStaff]?.id);
    expect(idpOf[portalUserId]).toBe(byZitadel[zCustomer]?.id);
  });

  it('gives the staff user a default membership with its department, and the portal user none', async () => {
    const m = await pool.query(
      `SELECT user_id, organization_id, is_default, role_keys, department_id
         FROM app.user_entities WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(m.rows).toEqual([
      {
        user_id: staffUserId,
        organization_id: staffId,
        is_default: true,
        role_keys: null,
        department_id: departmentId,
      },
    ]);
  });

  it('dedupes the re-keyed tenant tables, keeping the staff org rows', async () => {
    const rp = await pool.query(
      `SELECT role_key, permission, scope FROM app.role_permissions
        WHERE tenant_id = $1 AND role_key <> 'marketing' ORDER BY role_key, permission`,
      [tenantId],
    );
    // 0120 and 0121 add the settings and reopen rows to a tenant that stores grants; the credit.override rows are
    // 0104's (Founder, Management and Finance in every tenant with rows), and so are 0155's delivery_release rows, and 0175's vat.sales.read rows.
    expect(rp.rows).toEqual([
      { role_key: 'accountant', permission: 'quotation.record_acceptance', scope: 'all' },
      { role_key: 'accountant', permission: 'settings.finance.write', scope: 'all' },
      { role_key: 'accountant', permission: 'vat.sales.read', scope: 'all' },
      { role_key: 'finance', permission: 'credit.override', scope: 'all' },
      { role_key: 'finance', permission: 'customers.credit_limit.write', scope: 'all' },
      { role_key: 'finance', permission: 'memo.read', scope: 'all' },
      { role_key: 'finance', permission: 'profile.avatar.write', scope: 'own' },
      { role_key: 'finance', permission: 'sales_order.delivery_release', scope: 'all' },
      { role_key: 'finance', permission: 'settings.finance.write', scope: 'all' },
      { role_key: 'finance', permission: 'settings.fx_rate.write', scope: 'all' },
      { role_key: 'finance', permission: 'vat.sales.read', scope: 'all' },
      { role_key: 'founder', permission: 'approvals.definitions.publish', scope: 'all' },
      { role_key: 'founder', permission: 'credit.override', scope: 'all' },
      { role_key: 'founder', permission: 'crm.lead.reopen', scope: 'all' },
      { role_key: 'founder', permission: 'crm.opportunity.reopen', scope: 'all' },
      { role_key: 'founder', permission: 'customers.credit_limit.write', scope: 'all' },
      { role_key: 'founder', permission: 'customers.owner.write', scope: 'all' },
      { role_key: 'founder', permission: 'email_delivery.read', scope: 'all' },
      { role_key: 'founder', permission: 'email_delivery.resend', scope: 'all' },
      { role_key: 'founder', permission: 'sales_order.delivery_release', scope: 'all' },
      { role_key: 'founder', permission: 'settings.finance.write', scope: 'all' },
      { role_key: 'founder', permission: 'settings.fx_rate.write', scope: 'all' },
      { role_key: 'founder', permission: 'vat.sales.read', scope: 'all' },
      { role_key: 'management', permission: 'approvals.definitions.publish', scope: 'all' },
      { role_key: 'management', permission: 'approvals.definitions.read', scope: 'all' },
      { role_key: 'management', permission: 'credit.override', scope: 'all' },
      { role_key: 'management', permission: 'customers.owner.write', scope: 'all' },
      { role_key: 'management', permission: 'sales_order.delivery_release', scope: 'all' },
      { role_key: 'portal', permission: 'memo.read', scope: 'customer_org' },
    ]);
    const av = await pool.query('SELECT version FROM app.authz_versions WHERE tenant_id = $1', [
      tenantId,
    ]);
    // 5 after the 0013 dedupe, plus one when 0053 grants profile.avatar.write to the finance role in the seeded
    // tenant, plus one when 0083 gives the tenant its Marketing rows, plus one when 0088 widens the access model, plus one each when 0120 and 0121 seed the settings and reopen rows, plus one when 0127 seeds the workflow publish rows, plus one when 0128 seeds the email delivery rows. plus one when 0104 adds credit.override, plus one when 0150 adds the customer terms permissions, plus one when 0155 adds sales_order.delivery_release, plus one when 0175 adds vat.sales.read, plus one when 0178 adds the Accountant's quotation.record_acceptance.
    expect(av.rows).toEqual([{ version: '17' }]);
    const ur = await pool.query(
      'SELECT user_id, role_key FROM app.user_roles WHERE tenant_id = $1 ORDER BY role_key',
      [tenantId],
    );
    expect(ur.rows).toEqual([
      { user_id: staffUserId, role_key: 'finance' },
      { user_id: portalUserId, role_key: 'portal' },
    ]);
  });

  it('renames the memo counterparty to customer_party_id with kind customer, and moves the notification', async () => {
    const memo = await pool.query(
      'SELECT customer_party_id, customer_party_kind FROM app.test_memos WHERE id = $1',
      [memoId],
    );
    expect(memo.rows).toEqual([{ customer_party_id: customerId, customer_party_kind: 'customer' }]);
    const n = await pool.query('SELECT organization_id FROM app.notifications WHERE id = $1', [
      notificationId,
    ]);
    expect(n.rows).toEqual([{ organization_id: staffId }]);
  });

  it('keeps every audit chain month of the tenant valid', async () => {
    const months = await pool.query<{ chain_month: string }>(
      `SELECT DISTINCT to_char(chain_month, 'YYYY-MM-DD') AS chain_month
         FROM audit.audit_events WHERE tenant_id = $1`,
      [tenantId],
    );
    expect(months.rows.length).toBeGreaterThan(0);
    for (const { chain_month } of months.rows) {
      const v = await pool.query<{ ok: boolean; reason: string | null }>(
        'SELECT ok, reason FROM audit.verify_chain($1, $2::date)',
        [tenantId, chain_month],
      );
      expect(v.rows).toEqual([{ ok: true, reason: null }]);
    }
  });

  it('refuses a vendor party in customer_party_id (23503) and accepts a customer party', async () => {
    const memo = (customer: string) =>
      inTx(pool, settingsFor(tenantId, staffId), (c) =>
        insertMemo(c, {
          tenantId,
          organizationId: staffId,
          ownerUserId: staffUserId,
          customerColumn: 'customer_party_id',
          customerId: customer,
        }),
      );
    await expect(memo(customerId)).resolves.toBeDefined();
    await expect(memo(vendorId)).rejects.toMatchObject({
      code: '23503',
      constraint: 'test_memos_customer_party_fk',
    });
  });
});

describe('0013 refuses other rows owned by a customer or vendor org', () => {
  it('raises on a documents row owned by a customer org, naming the table', async () => {
    const ownerUrl = await createDatabase();
    await migrateTo0012(ownerUrl);
    const pool = new Pool({ connectionString: ownerUrl, max: 1 });
    try {
      const tenantId = randomUUID();
      const staffId = randomUUID();
      const customerId = randomUUID();
      await pool.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
      await inTx(pool, settingsFor(tenantId, staffId), async (c) => {
        await c.query(
          `INSERT INTO app.organizations (id, tenant_id, kind, name, zitadel_org_id)
           VALUES ($1, $3, 'staff', 'Techrida', $4), ($2, $3, 'customer', 'Customer', $5)`,
          [staffId, customerId, tenantId, `z-${randomUUID()}`, `z-${randomUUID()}`],
        );
        await c.query(
          `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
           VALUES ($1, $2, 'test_memo', $3)`,
          [tenantId, customerId, randomUUID()],
        );
      });

      // The pg error itself (Drizzle may wrap it, and a wrapper's message quotes the SQL text).
      const error: unknown = await runMigrations(ownerUrl).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeDefined();
      const pgError = ((error as { cause?: unknown }).cause ?? error) as {
        code?: string;
        message?: string;
      };
      expect(pgError.code).toBe('P0001');
      expect(pgError.message).toMatch(/app\.documents.*reset the dev database/s);
      // The migration rolled back: the old shape is still there.
      const { rows } = await pool.query<{ kind: string }>(
        'SELECT kind FROM app.organizations WHERE id = $1',
        [customerId],
      );
      expect(rows).toEqual([{ kind: 'customer' }]);
    } finally {
      await pool.end();
    }
  });

  it('raises on a tenant with two staff orgs (one staff IdP org per tenant)', async () => {
    const ownerUrl = await createDatabase();
    await migrateTo0012(ownerUrl);
    const pool = new Pool({ connectionString: ownerUrl, max: 1 });
    try {
      const tenantId = randomUUID();
      const staffId = randomUUID();
      await pool.query('INSERT INTO app.tenants (id) VALUES ($1)', [tenantId]);
      await inTx(pool, settingsFor(tenantId, staffId), (c) =>
        c.query(
          `INSERT INTO app.organizations (id, tenant_id, kind, name, zitadel_org_id)
           VALUES ($1, $2, 'staff', 'Techrida', $3), (gen_random_uuid(), $2, 'staff', 'Second', $4)`,
          [staffId, tenantId, `z-${randomUUID()}`, `z-${randomUUID()}`],
        ),
      );

      const error: unknown = await runMigrations(ownerUrl).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(error).toBeDefined();
      const pgError = ((error as { cause?: unknown }).cause ?? error) as {
        code?: string;
        message?: string;
      };
      expect(pgError.code).toBe('P0001');
      expect(pgError.message).toMatch(/2 staff organizations.*reset the dev database/s);
    } finally {
      await pool.end();
    }
  });
});
