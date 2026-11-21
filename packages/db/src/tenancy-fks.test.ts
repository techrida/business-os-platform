// Integration tests for the tenant and entity foreign keys: 0009_tenancy_fks and 0014_composite_keys, on a real,
// empty postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/db exec vitest run src/tenancy-fks.test.ts
//
// What 0009 must hold (review findings R17 and R28):
//   * every app table with tenant_id has a foreign key to app.tenants, so a row can never name a tenant that
//     does not exist;
//   * a published workflow version cannot move to another tenant or organization.
// What 0014 must hold (ADR 0027 section 8):
//   * a child row can never point at another tenant's parent: the foreign key carries tenant_id;
//   * between two entity-owned tables it also carries organization_id, so a row of one legal entity never
//     points at another entity's row of the same tenant;
//   * the approval group members still go when their group is deleted (ON DELETE CASCADE kept);
//   * checkTenancy() with its defaults (the strict rules on) finds nothing on the migrated schema.
// (0009's assert_org_kind test is gone: 0013 dropped that trigger for the party FK, tested in entities.test.ts.)
//
// Setup mirrors db.test.ts: the roles and default privileges of infra/postgres/init-dbs.sh, migrate as
// bos_owner, write as bos_app. bos_app gets a test actor per session so the audit trigger accepts the writes;
// a tenant-scoped row (users, idp_orgs, user_roles) also needs the acting entity, which inTx() sets.
import { randomUUID } from 'node:crypto';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { checkTenancy, describeViolations } from './check-tenancy.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

let testDb: TestDatabase;
let owner: Pool;
let app: Pool;

interface Scope {
  tenantId: string;
  organizationId: string;
}

/** Runs fn in one transaction as bos_app, with `organizationId` as the acting entity (like withTx). */
async function inTx<T>(organizationId: string, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const c = await app.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT set_config('bos.organization_id', $1, true)`, [organizationId]);
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

/** A tenant with its default legal entity (as bos_app). */
async function insertTenantOrg(): Promise<Scope> {
  const tenant = await app.query<{ id: string }>(
    'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
  );
  const tenantId = tenant.rows[0]?.id;
  if (tenantId === undefined) throw new Error('tenant insert returned no row');
  const organizationId = await insertOrg(tenantId, true);
  return { tenantId, organizationId };
}

/** A legal entity of `tenantId`. */
async function insertOrg(tenantId: string, isDefault = false): Promise<string> {
  const id = randomUUID();
  await app.query(
    `INSERT INTO app.organizations (id, tenant_id, organization_id, name, code, legal_name, is_default)
     VALUES ($1, $2, $1, $3, $3, $3, $4)`,
    [id, tenantId, `E-${id}`, isDefault],
  );
  return id;
}

/** A staff user of `scope`'s tenant, with the tenant's staff IdP org (created on first use). */
async function insertUser(scope: Scope): Promise<string> {
  return inTx(scope.organizationId, async (c) => {
    const existing = await c.query<{ id: string }>(
      `SELECT id FROM app.idp_orgs WHERE tenant_id = $1 AND kind = 'staff'`,
      [scope.tenantId],
    );
    const idpOrgId =
      existing.rows[0]?.id ??
      (
        await c.query<{ id: string }>(
          `INSERT INTO app.idp_orgs (tenant_id, zitadel_org_id, kind, name)
           VALUES ($1, $2, 'staff', 'Staff') RETURNING id`,
          [scope.tenantId, `zitadel-${randomUUID()}`],
        )
      ).rows[0]?.id;
    const user = await c.query<{ id: string }>(
      `INSERT INTO app.users (tenant_id, zitadel_user_id, status, idp_org_id)
       VALUES ($1, $2, 'active', $3) RETURNING id`,
      [scope.tenantId, `sub-${randomUUID()}`, idpOrgId],
    );
    const id = user.rows[0]?.id;
    if (id === undefined) throw new Error('user insert returned no row');
    return id;
  });
}

/** A published v1 workflow in `scope`, shaped like the seed's test_memo workflow. */
async function insertPublishedVersion(scope: Scope): Promise<string> {
  return (await insertWorkflow(scope)).versionId;
}

async function insertWorkflow(scope: Scope): Promise<{ definitionId: string; versionId: string }> {
  const definition = await app.query<{ id: string }>(
    `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
     VALUES ($1, $2, $3, 'Test', $3) RETURNING id`,
    [scope.tenantId, scope.organizationId, `wf-${randomUUID()}`],
  );
  const definitionId = definition.rows[0]?.id;
  const version = await app.query<{ id: string }>(
    `INSERT INTO app.workflow_versions
       (tenant_id, organization_id, definition_id, version, status, spec, published_at)
     VALUES ($1, $2, $3, 1, 'published', '{"steps": []}'::jsonb, now()) RETURNING id`,
    [scope.tenantId, scope.organizationId, definitionId],
  );
  const versionId = version.rows[0]?.id;
  if (definitionId === undefined || versionId === undefined) {
    throw new Error('workflow insert returned no row');
  }
  return { definitionId, versionId };
}

/** A pending approval request in `scope`, on a new published workflow. */
async function insertRequest(scope: Scope): Promise<string> {
  const { definitionId, versionId } = await insertWorkflow(scope);
  const requester = randomUUID();
  const request = await app.query<{ id: string }>(
    `INSERT INTO app.approval_requests (tenant_id, organization_id, definition_id, workflow_version_id,
       document_type, document_id, document_number, title, snapshot, snapshot_sha256, facts,
       requester_user_id, sod_user_ids, status, current_seq)
     VALUES ($1, $2, $3, $4, 'test_memo', $5, 'MEMO-1', 'A memo', '{}', $6, '{}', $7, $8, 'pending', 1)
     RETURNING id`,
    [
      scope.tenantId,
      scope.organizationId,
      definitionId,
      versionId,
      randomUUID(),
      Buffer.alloc(32, 1),
      requester,
      [requester],
    ],
  );
  const id = request.rows[0]?.id;
  if (id === undefined) throw new Error('approval request insert returned no row');
  return id;
}

async function insertDocument(scope: Scope): Promise<string> {
  const doc = await app.query<{ id: string }>(
    `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
     VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
    [scope.tenantId, scope.organizationId, randomUUID()],
  );
  const id = doc.rows[0]?.id;
  if (id === undefined) throw new Error('document insert returned no row');
  return id;
}

function insertDocumentVersion(scope: Scope, documentId: string, version: number) {
  return app.query(
    `INSERT INTO app.document_versions
       (tenant_id, organization_id, document_id, version, filename, declared_mime, size_bytes, storage_key)
     VALUES ($1, $2, $3, $4, 'a.pdf', 'application/pdf', 10, $5)`,
    [scope.tenantId, scope.organizationId, documentId, version, `k/${randomUUID()}`],
  );
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  // The audit trigger refuses a write with no actor; these tests write directly, so the session supplies one.
  for (const [key, value] of [
    ['bos.actor_kind', 'system'],
    ['bos.actor_id', 'system:tenancy-fks-test'],
    ['bos.correlation_id', 'tenancy-fks-test-0001'],
  ]) {
    await bosAdmin.query(`ALTER ROLE bos_app IN DATABASE ${testDb.name} SET ${key} = '${value}'`);
  }
  await bosAdmin.end();

  owner = new Pool({ connectionString: testDb.ownerUrl, max: 2 });
  app = new Pool({ connectionString: testDb.appUrl, max: 2 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await testDb?.drop();
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

  // An unknown tenant fails the tenant FK and, since 0014, the composite ones too. Which of them PostgreSQL
  // reports depends on trigger order, so only the code is asserted; the catalog test above pins the tenant FK.
  it('0004: rejects a document version with an unknown tenant_id (23503)', async () => {
    const scope = await insertTenantOrg();
    const documentId = await insertDocument(scope);
    await expect(
      insertDocumentVersion(
        { tenantId: randomUUID(), organizationId: scope.organizationId },
        documentId,
        1,
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('0006: rejects an approval group with an unknown tenant_id (23503)', async () => {
    const scope = await insertTenantOrg();
    await expect(
      app.query(
        `INSERT INTO app.approval_groups (tenant_id, organization_id, key, name)
         VALUES ($1, $2, 'g', 'Group')`,
        [randomUUID(), scope.organizationId],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('0006: still accepts seed-shaped rows in a real tenant', async () => {
    const scope = await insertTenantOrg();
    await expect(insertPublishedVersion(scope)).resolves.toEqual(expect.any(String));
  });
});

describe('R28: a published workflow version keeps its tenant and organization', () => {
  // The guard is a BEFORE trigger, so it answers (23514) before 0014's foreign keys are checked.
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
    const sibling = await insertOrg(scope.tenantId);
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

describe('ADR 0027 section 8: composite keys (0014)', () => {
  // Each case is built so that exactly one foreign key can fail: the tenant and the entity are real, only the
  // parent belongs elsewhere.
  it('rejects a child row of tenant T2 that points at a user of tenant T1 (23503)', async () => {
    const t1 = await insertTenantOrg();
    const t2 = await insertTenantOrg();
    const t1User = await insertUser(t1);
    await expect(
      inTx(t2.organizationId, (c) =>
        c.query(`INSERT INTO app.user_roles (tenant_id, user_id, role_key) VALUES ($1, $2, 'r')`, [
          t2.tenantId,
          t1User,
        ]),
      ),
    ).rejects.toMatchObject({ code: '23503', constraint: 'user_roles_user_fk' });
  });

  it("rejects a document version of entity E2 that points at E1's document (23503)", async () => {
    const e1 = await insertTenantOrg();
    const e2: Scope = { tenantId: e1.tenantId, organizationId: await insertOrg(e1.tenantId) };
    const documentId = await insertDocument(e1);
    // The same entity is fine.
    await insertDocumentVersion(e1, documentId, 1);
    await expect(insertDocumentVersion(e2, documentId, 2)).rejects.toMatchObject({
      code: '23503',
      constraint: 'document_versions_document_fk',
    });
  });

  it("rejects an approval step of entity E2 that points at E1's request (23503)", async () => {
    const e1 = await insertTenantOrg();
    const e2: Scope = { tenantId: e1.tenantId, organizationId: await insertOrg(e1.tenantId) };
    const requestId = await insertRequest(e1);
    const step = (scope: Scope, seq: number) =>
      app.query(
        `INSERT INTO app.approval_steps (tenant_id, organization_id, request_id, seq, kind, user_id, reason)
         VALUES ($1, $2, $3, $4, 'user', $5, 'test')`,
        [scope.tenantId, scope.organizationId, requestId, seq, randomUUID()],
      );
    await step(e1, 1);
    await expect(step(e2, 2)).rejects.toMatchObject({
      code: '23503',
      constraint: 'approval_steps_request_fk',
    });
  });

  it('still deletes the members of a deleted approval group (ON DELETE CASCADE)', async () => {
    const scope = await insertTenantOrg();
    const group = await app.query<{ id: string }>(
      `INSERT INTO app.approval_groups (tenant_id, organization_id, key, name)
       VALUES ($1, $2, 'g', 'Group') RETURNING id`,
      [scope.tenantId, scope.organizationId],
    );
    const groupId = group.rows[0]?.id;
    await app.query(
      `INSERT INTO app.approval_group_members (tenant_id, organization_id, group_id, user_id)
       VALUES ($1, $2, $3, $4), ($1, $2, $3, $5)`,
      [scope.tenantId, scope.organizationId, groupId, randomUUID(), randomUUID()],
    );
    await app.query('DELETE FROM app.approval_groups WHERE id = $1', [groupId]);
    const { rows } = await app.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app.approval_group_members WHERE group_id = $1',
      [groupId],
    );
    expect(rows[0]?.n).toBe(0);
  });

  it('passes checkTenancy() with its defaults on the migrated schema', async () => {
    const violations = await checkTenancy(owner);
    expect(violations, describeViolations(violations)).toEqual([]);
  });
});
