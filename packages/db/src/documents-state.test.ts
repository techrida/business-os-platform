// Integration tests for migration 0010_documents_state: a document version keeps its identity and its status
// moves only along allowed transitions. Needs Docker (Testcontainers, postgres:16-alpine).
// Run with: pnpm --filter @bos/db exec vitest run src/documents-state.test.ts
//
// The setup mirrors audit.test.ts (roles, database, default privileges, migrate as bos_owner). The writes run
// as bos_app inside one transaction with the bos.* settings, like withTx() does, because the audit triggers
// on app.documents and app.document_versions refuse a write without an actor.
import { randomUUID } from 'node:crypto';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { runMigrations } from './migrate.js';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let superuser: Pool;
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

/** Runs fn in one transaction on bos_app, after set_config(..., true) of the bos.* settings (like withTx). */
async function inTx<T>(scope: Scope, fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const settings: Record<string, string> = {
    'bos.tenant_id': scope.tenantId,
    'bos.organization_id': scope.organizationId,
    'bos.actor_kind': 'system',
    'bos.actor_id': 'documents-state-test',
    'bos.correlation_id': randomUUID(),
    'bos.ip': '',
    'bos.user_agent': '',
  };
  const c = await app.connect();
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

/** A fresh tenant and organization. */
async function newScope(): Promise<Scope> {
  const { rows: tenants } = await app.query<{ id: string }>(
    'INSERT INTO app.tenants DEFAULT VALUES RETURNING id',
  );
  const tenantId = tenants[0]?.id ?? '';
  const scope = { tenantId, organizationId: randomUUID() };
  const orgId = await inTx(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.organizations (tenant_id, kind, name, zitadel_org_id)
       VALUES ($1, 'customer', 'Acme', $2) RETURNING id`,
      [tenantId, `z-${randomUUID()}`],
    );
    return rows[0]?.id ?? '';
  });
  return { tenantId, organizationId: orgId };
}

/** A document with one version in `status`. A scanned version has its sha256, like the real flow. */
async function newVersion(status: string, withHash = status !== 'awaiting_content') {
  const scope = await newScope();
  const versionId = randomUUID();
  await inTx(scope, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.documents (tenant_id, organization_id, owner_type, owner_id)
       VALUES ($1, $2, 'test_memo', $3) RETURNING id`,
      [scope.tenantId, scope.organizationId, randomUUID()],
    );
    await c.query(
      `INSERT INTO app.document_versions (id, tenant_id, organization_id, document_id, version, filename,
         declared_mime, size_bytes, sha256, storage_key, status)
       VALUES ($1, $2, $3, $4, 1, 'report.pdf', 'application/pdf', 10, $5, $6, $7)`,
      [
        versionId,
        scope.tenantId,
        scope.organizationId,
        rows[0]?.id,
        withHash ? Buffer.alloc(32, 7) : null,
        `${scope.tenantId}/${versionId}`,
        status,
      ],
    );
  });
  return { scope, versionId };
}

/** Runs one UPDATE of the version as bos_app, in its own transaction. */
function update(v: { scope: Scope; versionId: string }, set: string, params: unknown[] = []) {
  return inTx(v.scope, (c) =>
    c.query(`UPDATE app.document_versions SET ${set} WHERE id = $1`, [v.versionId, ...params]),
  );
}

async function statusOf(versionId: string): Promise<string | undefined> {
  const { rows } = await owner.query<{ status: string }>(
    'SELECT status FROM app.document_versions WHERE id = $1',
    [versionId],
  );
  return rows[0]?.status;
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

  superuser = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await superuser.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await superuser.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await superuser.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE, SELECT ON SEQUENCES TO bos_app',
  );

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  owner = new Pool({ connectionString: urlFor('bos_owner', OWNER_PW, 'bos'), max: 2 });
  app = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 5 });
});

afterAll(async () => {
  await app?.end();
  await owner?.end();
  await superuser?.end();
  await container?.stop();
});

describe('document version identity', () => {
  it('raises on an UPDATE of filename on a clean version', async () => {
    const v = await newVersion('clean');
    await expect(update(v, `filename = 'other.pdf'`)).rejects.toThrow(/immutable|clean/);
  });

  it('raises on an UPDATE of filename on a version that is not clean yet', async () => {
    const v = await newVersion('quarantined');
    await expect(update(v, `filename = 'other.pdf'`)).rejects.toThrow(/immutable/);
  });

  it('raises when tenant, organization, sha256 or storage key change', async () => {
    const v = await newVersion('quarantined');
    await expect(update(v, 'tenant_id = $2', [randomUUID()])).rejects.toThrow(/immutable/);
    await expect(update(v, 'organization_id = $2', [randomUUID()])).rejects.toThrow(/immutable/);
    await expect(update(v, 'sha256 = $2', [Buffer.alloc(32, 9)])).rejects.toThrow(/immutable/);
    await expect(update(v, `storage_key = 'elsewhere'`)).rejects.toThrow(/immutable/);
  });

  it('still lets sha256 be set once, after NULL (the upload records what it received)', async () => {
    const v = await newVersion('awaiting_content');
    await update(v, `sha256 = $2, size_bytes = 12, detected_mime = 'application/pdf'`, [
      Buffer.alloc(32, 1),
    ]);
    await expect(update(v, 'sha256 = $2', [Buffer.alloc(32, 2)])).rejects.toThrow(/immutable/);
  });
});

describe('document version status transitions', () => {
  it('raises on clean -> awaiting_content (uploading) and leaves the status alone', async () => {
    const v = await newVersion('clean');
    await expect(update(v, `status = 'awaiting_content'`)).rejects.toThrow();
    expect(await statusOf(v.versionId)).toBe('clean');
  });

  it('allows scan_failed -> quarantined (a rescan)', async () => {
    const v = await newVersion('scan_failed');
    await update(v, `status = 'quarantined'`);
    expect(await statusOf(v.versionId)).toBe('quarantined');
  });

  it.each([
    ['awaiting_content', 'quarantined'],
    ['quarantined', 'clean'],
    ['quarantined', 'infected'],
    ['quarantined', 'scan_failed'],
    ['quarantined', 'rejected'],
    ['scan_failed', 'quarantined'],
  ])('allows %s -> %s', async (from, to) => {
    const v = await newVersion(from);
    await update(v, `status = '${to}'`);
    expect(await statusOf(v.versionId)).toBe(to);
  });

  it('allows reopening a quarantined version whose bytes were never recorded', async () => {
    const v = await newVersion('quarantined', false);
    await update(v, `status = 'awaiting_content'`);
    expect(await statusOf(v.versionId)).toBe('awaiting_content');
  });

  it.each([
    ['awaiting_content', 'clean'],
    ['awaiting_content', 'infected'],
    ['awaiting_content', 'scan_failed'],
    ['quarantined', 'awaiting_content'], // bytes recorded (sha256 set): cannot be reset
    ['infected', 'quarantined'],
    ['infected', 'clean'],
    ['infected', 'awaiting_content'],
    ['rejected', 'quarantined'],
    ['rejected', 'awaiting_content'],
    ['scan_failed', 'clean'],
    ['scan_failed', 'awaiting_content'],
    ['clean', 'quarantined'],
    ['clean', 'infected'],
  ])('raises on %s -> %s', async (from, to) => {
    const v = await newVersion(from);
    await expect(update(v, `status = '${to}'`)).rejects.toThrow();
    expect(await statusOf(v.versionId)).toBe(from);
  });

  it('does not treat an UPDATE that keeps the status as a transition', async () => {
    const v = await newVersion('infected');
    await update(v, `scan_signature = 'Eicar-Test', updated_at = now()`);
    expect(await statusOf(v.versionId)).toBe('infected');
  });
});
