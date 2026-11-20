// Migration 0110 (F1-Q30, the tax invoice route by source) on real Postgres: an entity still on the seeded original
// tax_invoice route gets the new route as its next published version (the old one retired, unchanged), audited as
// system:migration-0110; an entity whose admin changed the route, and every other document type, are untouched; and
// running the migration's SQL again changes nothing.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity } from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const ACTOR = 'system:migration-0110';
const SQL_FILE = join(MIGRATIONS_FOLDER, '0110_tax_invoice_route.sql');

/** The route the seed published as v1 before F1-Q30 (tools/seed-zitadel invoiceApprovalSpec). */
const original = (documentType: string, what: string) => ({
  documentType,
  steps: [
    {
      id: 'accountant',
      kind: 'role',
      role: 'accountant',
      reason: `Base route: accountant checks the ${what}`,
    },
    { id: 'finance', kind: 'role', role: 'finance', reason: 'Base route: finance approves' },
  ],
  rules: [],
  distinctApprovers: true,
  sla: { remindAfterHours: 24, escalateAfterHours: 72, escalateTo: { role: 'founder' } },
});

let container: StartedPostgreSqlContainer;

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE bos_tax_invoice_route OWNER bos_owner');
  await admin.end();
});

afterAll(async () => {
  await container?.stop();
});

function ownerUrl(): string {
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos_tax_invoice_route';
  return url.toString();
}

/** Migrates to the last migration before 0110: the journal is cut by file number. */
async function migrateBefore0110(url: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bos-pre-0110-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 110);
    writeFileSync(journalPath, JSON.stringify(journal));
    const { db, close } = createDb(url, { max: 1 });
    try {
      await migrate(db, { migrationsFolder: folder });
    } finally {
      await close();
    }
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
}

async function inTx<T>(
  pool: Pool,
  scope: { tenantId: string; organizationId: string },
  fn: (c: PoolClient) => Promise<T>,
): Promise<T> {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const settings: Record<string, string> = {
      'bos.tenant_id': scope.tenantId,
      'bos.organization_id': scope.organizationId,
      'bos.actor_kind': 'system',
      'bos.actor_id': 'tax-invoice-route-migration-test',
      'bos.correlation_id': randomUUID(),
      'bos.ip': '',
      'bos.user_agent': '',
    };
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

/** A workflow with its versions in order; the last one is published and current, the earlier ones retired. */
async function seedWorkflow(
  pool: Pool,
  t: { tenantId: string; organizationId: string },
  key: string,
  specs: unknown[],
): Promise<string> {
  return inTx(pool, t, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.workflow_definitions (tenant_id, organization_id, key, name, document_type)
       VALUES ($1, $2, $3, $3, $3) RETURNING id`,
      [t.tenantId, t.organizationId, key],
    );
    const definitionId = rows[0]!.id;
    let current = '';
    for (const [i, spec] of specs.entries()) {
      const last = i === specs.length - 1;
      const v = await c.query<{ id: string }>(
        `INSERT INTO app.workflow_versions
           (tenant_id, organization_id, definition_id, version, status, spec, published_at, published_by)
         VALUES ($1, $2, $3, $4, $5, $6::jsonb, now(), NULL) RETURNING id`,
        [
          t.tenantId,
          t.organizationId,
          definitionId,
          i + 1,
          last ? 'published' : 'retired',
          JSON.stringify(spec),
        ],
      );
      current = v.rows[0]!.id;
    }
    await c.query('UPDATE app.workflow_definitions SET current_version_id = $1 WHERE id = $2', [
      current,
      definitionId,
    ]);
    return definitionId;
  });
}

interface VersionRow {
  version: number;
  status: string;
  spec: { steps: unknown[]; rules: { id: string }[] };
  current: boolean;
}

async function versionsOf(pool: Pool, definitionId: string): Promise<VersionRow[]> {
  const { rows } = await pool.query<VersionRow>(
    `SELECT v.version, v.status, v.spec, (d.current_version_id = v.id) AS current
     FROM app.workflow_versions v JOIN app.workflow_definitions d ON d.id = v.definition_id
     WHERE v.definition_id = $1 ORDER BY v.version`,
    [definitionId],
  );
  return rows;
}

/** The migration's statements, run again in one transaction as the migrator runs them. */
async function rerun0110(pool: Pool): Promise<void> {
  const statements = readFileSync(SQL_FILE, 'utf8').split('--> statement-breakpoint');
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const statement of statements) await c.query(statement);
    await c.query('COMMIT');
  } catch (error) {
    await c.query('ROLLBACK');
    throw error;
  } finally {
    c.release();
  }
}

describe('0110 tax invoice route by source', () => {
  it('moves only entities on the original route, keeps the old version for its requests, and is idempotent', async () => {
    const url = ownerUrl();
    await migrateBefore0110(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      // A: the seeded original tax invoice route, and the original credit note route.
      const a = await createTenantWithEntity(pool);
      const aInvoice = await seedWorkflow(pool, a, 'tax_invoice', [
        original('tax_invoice', 'tax invoice'),
      ]);
      const aCredit = await seedWorkflow(pool, a, 'credit_note', [
        original('credit_note', 'credit note'),
      ]);
      // B: an admin already published their own tax invoice route as v2.
      const b = await createTenantWithEntity(pool);
      const edited = {
        ...original('tax_invoice', 'tax invoice'),
        steps: [{ id: 'finance', kind: 'role', role: 'finance', reason: 'Our own route' }],
      };
      const bInvoice = await seedWorkflow(pool, b, 'tax_invoice', [
        original('tax_invoice', 'tax invoice'),
        edited,
      ]);

      await runMigrations(url);

      const aVersions = await versionsOf(pool, aInvoice);
      expect(aVersions.map((v) => [v.version, v.status, v.current])).toEqual([
        [1, 'retired', false],
        [2, 'published', true],
      ]);
      // v1 is frozen as it was: requests opened under it keep routing by it.
      expect(aVersions[0]!.spec).toEqual(original('tax_invoice', 'tax invoice'));
      expect(aVersions[1]!.spec.steps).toEqual([]);
      expect(aVersions[1]!.spec.rules.map((r) => r.id)).toEqual([
        'manual-invoice',
        'finance-approves',
      ]);

      // The credit note route and B's edited route are left alone.
      expect((await versionsOf(pool, aCredit)).map((v) => [v.version, v.status])).toEqual([
        [1, 'published'],
      ]);
      const bVersions = await versionsOf(pool, bInvoice);
      expect(bVersions.map((v) => [v.version, v.status, v.current])).toEqual([
        [1, 'retired', false],
        [2, 'published', true],
      ]);
      expect(bVersions[1]!.spec).toEqual(edited);

      // Audited as the migration, in A only.
      const audited = await pool.query<{ tenant_id: string }>(
        `SELECT DISTINCT tenant_id FROM audit.audit_events
         WHERE actor_id = $1 AND entity_type IN ('workflow_versions', 'workflow_definitions')`,
        [ACTOR],
      );
      expect(audited.rows.map((r) => r.tenant_id)).toEqual([a.tenantId]);

      await rerun0110(pool);
      expect((await versionsOf(pool, aInvoice)).map((v) => [v.version, v.status])).toEqual([
        [1, 'retired'],
        [2, 'published'],
      ]);
    } finally {
      await pool.end();
    }
  });
});
