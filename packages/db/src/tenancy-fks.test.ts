// Integration tests for 0009_tenancy_fks: a real, empty postgres:16-alpine started by Testcontainers (needs
// Docker). Run with: pnpm --filter @bos/db exec vitest run src/tenancy-fks.test.ts
//
// What 0009 must hold (review findings R17 and R28):
//   * every app table with tenant_id has a foreign key to app.tenants, including the 0004 and 0006 tables
//     that were created without one, so a row can never name a tenant that does not exist;
//   * a published workflow version cannot move to another tenant or organization;
//   * assert_org_kind re-checks the counterparty when a row's tenant_id changes, not only when the
//     counterparty column changes.
//
// Setup mirrors db.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app. bos_app gets a test actor per session so the audit trigger accepts the writes.
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let owner: Pool;
let app: Pool;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** A tenant with one organization of the given kind (as bos_app). */
async function insertTenantOrg(kind: 'staff' | 'customer' | 'vendor' = 'staff'): Promise<Scope> {
  const tenant = await app.query<{ id: string }>(
    'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
  );
  const tenantId = tenant.rows[0]?.id;
  if (tenantId === undefined) throw new Error('tenant insert returned no row');
  const organizationId = await insertOrg(tenantId, kind);
  return { tenantId, organizationId };
}

async function insertOrg(tenantId: string, kind: 'staff' | 'customer' | 'vendor'): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, kind, name, zitadel_org_id)
     VALUES ($1, $2, $1, $3, $4, $5)`,
    [id, tenantId, kind, `${kind} org`, `zitadel-${id}`],
  );
  return id;
}

/** A published v1 workflow in `scope`, shaped like the seed's test_memo workflow. */
async function insertPublishedVersion(scope: Scope): Promise<string> {
  const definition = await app.query<{ id: string }>(
    `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
     VALUES ($1, $2, $3, 'Test', $3) RETURNING id`,
    [scope.tenantId, scope.organizationId, `wf-${randomUUID()}`],
  );
  const version = await app.query<{ id: string }>(
    `INSERT INTO app.workflow_versions
       (tenant_id, organization_id, definition_id, version, status, spec, published_at)
     VALUES ($1, $2, $3, 1, 'published', '{"steps": []}'::jsonb, now()) RETURNING id`,
    [scope.tenantId, scope.organizationId, definition.rows[0]?.id],
  );
  const id = version.rows[0]?.id;
  if (id === undefined) throw new Error('workflow version insert returned no row');
  return id;
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
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:tenancy-fks-test'],
    ['bos.correlation_id', 'tenancy-fks-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE bos SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  owner = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  app = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await container?.stop();
});

describe('R17: every app table with tenant_id references app.tenants', () => {
  it('has a tenant foreign key on every app table that carries tenant_id', async () => {
    // Catalog check over all tables, so a table this file does not exercise is still covered.
    const { rows } = await owner.query<{ table_name: string }>(
      `SELECT c.relname AS table_name
         FROM pg_class c
         JOIN pg_namespace n ON n.oid = c.relnamespace
         JOIN pg_attribute a ON a.attrelid = c.oid AND a.attname = 'tenant_id' AND NOT a.attisdropped
        WHERE n.nspname = 'app' AND c.relkind IN ('r', 'p')
          AND NOT EXISTS (
            SELECT 1 FROM pg_constraint con
             WHERE con.conrelid = c.oid AND con.contype = 'f'
               AND con.confrelid = 'app.tenants'::regclass
               AND con.conkey = ARRAY[a.attnum]
               AND con.convalidated
          )
        ORDER BY 1`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([]);
  });

  it('0004: rejects a document version with an unknown tenant_id (23503)', async () => {
    const scope = await insertTenantOrg();
    const doc = await app.query<{ id: string }>(
      `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
       VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
      [scope.tenantId, scope.organizationId, randomUUID()],
    );
    // A valid document_id, so the only constraint that can fail is the tenant one.
    await expect(
      app.query(
        `INSERT INTO app.document_versions
           (tenant_id, organization_id, document_id, version, filename, declared_mime, size_bytes, storage_key)
         VALUES ($1, $2, $3, 1, 'a.pdf', 'application/pdf', 10, $4)`,
        [randomUUID(), scope.organizationId, doc.rows[0]?.id, `k/${randomUUID()}`],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'document_versions_tenant_id_tenants_id_fk',
    });
  });

  it('0006: rejects an approval group with an unknown tenant_id (23503)', async () => {
    const scope = await insertTenantOrg();
    await expect(
      app.query(
        `INSERT INTO app.approval_groups (tenant_id, organization_id, key, name)
         VALUES ($1, $2, 'g', 'Group')`,
        [randomUUID(), scope.organizationId],
      ),
    ).rejects.toMatchObject({
      code: '23503',
      constraint: 'approval_groups_tenant_id_tenants_id_fk',
    });
  });

  it('0006: still accepts seed-shaped rows in a real tenant', async () => {
    const scope = await insertTenantOrg();
    await expect(insertPublishedVersion(scope)).resolves.toEqual(expect.any(String));
  });
});

describe('R28: a published workflow version keeps its tenant and organization', () => {
  it('rejects moving a published version to another tenant (23514)', async () => {
    const scope = await insertTenantOrg();
    const other = await insertTenantOrg();
    const id = await insertPublishedVersion(scope);
    await expect(
      app.query(
        'UPDATE app.workflow_versions SET tenant_id = $1, organization_id = $2 WHERE id = $3',
        [other.tenantId, other.organizationId, id],
      ),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects moving a published version to another organization of the same tenant (23514)', async () => {
    const scope = await insertTenantOrg();
    const sibling = await insertOrg(scope.tenantId, 'staff');
    const id = await insertPublishedVersion(scope);
    await expect(
      app.query('UPDATE app.workflow_versions SET organization_id = $1 WHERE id = $2', [
        sibling,
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  // 0006 already froze definition_id; 0009 rewrites the guard function, so this keeps that rule pinned.
  it('still rejects moving a published version to another definition (23514)', async () => {
    const scope = await insertTenantOrg();
    const id = await insertPublishedVersion(scope);
    const other = await app.query<{ id: string }>(
      `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
       VALUES ($1, $2, 'other-wf', 'Other', 'other-wf') RETURNING id`,
      [scope.tenantId, scope.organizationId],
    );
    await expect(
      app.query('UPDATE app.workflow_versions SET definition_id = $1 WHERE id = $2', [
        other.rows[0]?.id,
        id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('still lets a draft be published and a published version be retired', async () => {
    const scope = await insertTenantOrg();
    const definition = await app.query<{ id: string }>(
      `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
       VALUES ($1, $2, 'draft-wf', 'Draft', 'draft-wf') RETURNING id`,
      [scope.tenantId, scope.organizationId],
    );
    const version = await app.query<{ id: string }>(
      `INSERT INTO app.workflow_versions (tenant_id, organization_id, definition_id, version, spec)
       VALUES ($1, $2, $3, 1, '{"steps": []}'::jsonb) RETURNING id`,
      [scope.tenantId, scope.organizationId, definition.rows[0]?.id],
    );
    const id = version.rows[0]?.id;
    await app.query(
      `UPDATE app.workflow_versions SET status = 'published', published_at = now() WHERE id = $1`,
      [id],
    );
    await app.query(`UPDATE app.workflow_versions SET status = 'retired' WHERE id = $1`, [id]);
    const { rows } = await app.query<{ status: string }>(
      'SELECT status FROM app.workflow_versions WHERE id = $1',
      [id],
    );
    expect(rows[0]?.status).toBe('retired');
  });
});

describe('R28: assert_org_kind fires when tenant_id changes', () => {
  it('rejects moving a memo to a tenant its customer organization does not belong to (23514)', async () => {
    const scope = await insertTenantOrg();
    const customer = await insertOrg(scope.tenantId, 'customer');
    const other = await insertTenantOrg();
    const user = await app.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, organization_id, zitadel_user_id, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [scope.tenantId, scope.organizationId, `sub-${randomUUID()}`],
    );
    const memo = await app.query<{ id: string }>(
      `INSERT INTO app.test_memos
         (tenant_id, organization_id, number, title, body, amount, currency, amount_npr, fx_rate,
          fx_source, fx_date, owner_user_id, customer_organization_id)
       VALUES ($1, $2, $3, 'Memo', 'Body', 10, 'NPR', 10, 1, 'identity', '2026-01-01', $4, $5)
       RETURNING id`,
      [scope.tenantId, scope.organizationId, `MEMO-${randomUUID()}`, user.rows[0]?.id, customer],
    );
    // Only tenant_id is set, so before 0009 the trigger (UPDATE OF customer_organization_id) never ran.
    await expect(
      app.query('UPDATE app.test_memos SET tenant_id = $1 WHERE id = $2', [
        other.tenantId,
        memo.rows[0]?.id,
      ]),
    ).rejects.toMatchObject({ code: '23514' });
  });
});
