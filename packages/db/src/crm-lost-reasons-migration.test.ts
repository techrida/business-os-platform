// Migrations 0071-0072 (lost reasons as a per-tenant list, D49) on real Postgres: every tenant gets the seven
// default options, and each lost lead's free-text reason becomes a reference to an option, audited as the migration.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const ACTOR = 'system:migration-0072';

let testDb: TestDatabase;

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
});

afterAll(async () => {
  await testDb?.drop();
});

function ownerUrl(): string {
  return testDb.ownerUrl;
}

/** Migrates to the last migration before 0071: the journal is cut by file number, as the follow-up test does. */
async function migrateBefore0071(url: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bos-pre-0071-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 71);
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
      'bos.actor_id': 'lost-reasons-migration-test',
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

const DEFAULTS = [
  'Price',
  'Chose a competitor',
  'No budget',
  'No response',
  'Not a fit',
  'Timing',
  'Other',
];

describe('0071-0072 lost reasons on seeded old-shape leads', () => {
  it('seeds the defaults per tenant and moves each lost lead onto an option, audited as the migration', async () => {
    const url = ownerUrl();
    await migrateBefore0071(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const a = await createTenantWithEntity(pool);
      const b = await createTenantWithEntity(pool);
      const seed = async (
        t: { tenantId: string; organizationId: string },
        rows: [string, string, string | null, string | null][],
      ) =>
        inTx(pool, t, async (c) => {
          const ids: string[] = [];
          for (const [number, stage, reason, note] of rows) {
            const { rows: out } = await c.query<{ id: string }>(
              `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, company_name,
                                      contact_name, stage, stage_reason, stage_note)
               VALUES ($1, $2, $3, 'Lead', 'website', 'Acme', 'Asha', $4, $5, $6) RETURNING id`,
              [t.tenantId, t.organizationId, number, stage, reason, note],
            );
            ids.push(out[0]!.id);
          }
          return ids;
        });
      const [exact, spaced, key, other, open] = await seed(a, [
        ['LD-1', 'lost', 'Price', 'Too dear'],
        ['LD-2', 'lost', '  chose a COMPETITOR ', 'Went with X'],
        ['LD-3', 'lost', 'no_budget', 'Went quiet'],
        ['LD-4', 'lost', 'Pricing was too high', 'Asked twice'],
        ['LD-5', 'new', null, null],
      ]);
      const [otherTenant] = await seed(b, [['LD-1', 'lost', 'Timing', 'Next year']]);

      await runMigrations(url);

      for (const t of [a, b]) {
        const { rows } = await pool.query<{ label: string; default_key: string; position: number }>(
          'SELECT label, default_key, position FROM app.lead_lost_reasons WHERE tenant_id = $1 ORDER BY position',
          [t.tenantId],
        );
        expect(rows.map((r) => r.label)).toEqual(DEFAULTS);
        expect(rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);
      }

      const leads = await pool.query<{
        id: string;
        label: string | null;
        stage_reason: string | null;
        stage_note: string | null;
      }>(
        `SELECT l.id, r.label, l.stage_reason, l.stage_note FROM app.leads l
           LEFT JOIN app.lead_lost_reasons r ON r.tenant_id = l.tenant_id AND r.id = l.lost_reason_id
          WHERE l.id = ANY($1)`,
        [[exact, spaced, key, other, open, otherTenant]],
      );
      const by = new Map(leads.rows.map((r) => [r.id, r]));
      expect(by.get(exact!)).toMatchObject({
        label: 'Price',
        stage_reason: 'Price',
        stage_note: 'Too dear',
      });
      expect(by.get(spaced!)).toMatchObject({
        label: 'Chose a competitor',
        stage_reason: 'Chose a competitor',
      });
      expect(by.get(key!)).toMatchObject({
        label: 'No budget',
        stage_reason: 'No budget',
        stage_note: 'Went quiet',
      });
      // No option matches: Other, with the old words kept at the front of the note.
      expect(by.get(other!)).toMatchObject({
        label: 'Other',
        stage_reason: 'Other',
        stage_note: 'Reason given: Pricing was too high\nAsked twice',
      });
      // An open lead is untouched, and a lead only ever points at an option of its own tenant.
      expect(by.get(open!)).toMatchObject({ label: null, stage_reason: null, stage_note: null });
      expect(by.get(otherTenant!)).toMatchObject({ label: 'Timing' });

      // Audit: the four lost leads of tenant A and the one of tenant B, as the migration.
      const audited = await pool.query<{ entity_id: string }>(
        `SELECT DISTINCT entity_id FROM audit.audit_events
          WHERE actor_id = $1 AND entity_type = 'leads'`,
        [ACTOR],
      );
      expect(audited.rows.map((r) => r.entity_id).sort()).toEqual(
        [exact, spaced, key, other, otherTenant].sort(),
      );
    } finally {
      await pool.end();
    }
  });
});
