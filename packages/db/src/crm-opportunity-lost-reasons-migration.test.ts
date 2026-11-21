// Migrations 0090-0091 (opportunity lost reasons from the shared per-tenant list, D49, D54-3) on real Postgres:
// tenants with unmigrated lost opportunities and no options yet get the seven defaults, each lost opportunity's
// free-text reason becomes a reference to an option (or Other with the old words in the note), audited as
// system:migration-0091, other tenants are untouched, and re-running 0091 is idempotent.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createParty, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const ACTOR = 'system:migration-0091';
const ADDRESS = JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' });

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

/** Migrates to the last migration before 0090: the journal is cut by file number, as the 0071-0072 test does. */
async function migrateBefore0090(url: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bos-pre-0090-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 90);
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
      'bos.actor_id': 'opp-lost-reasons-migration-test',
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

const DEFAULT_TUPLES: readonly [string, string, number][] = [
  ['price', 'Price', 0],
  ['competitor', 'Chose a competitor', 1],
  ['no_budget', 'No budget', 2],
  ['no_response', 'No response', 3],
  ['not_a_fit', 'Not a fit', 4],
  ['timing', 'Timing', 5],
  ['other', 'Other', 6],
];

async function seedCustomer(
  pool: Pool,
  t: { tenantId: string; organizationId: string },
): Promise<string> {
  const { partyId } = await createParty(pool, { tenantId: t.tenantId, kind: 'customer' });
  await inTx(pool, t, async (c) => {
    await c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
      [partyId, t.tenantId, `CUS-${partyId.slice(0, 8)}`, ADDRESS],
    );
  });
  return partyId;
}

describe('0090-0091 opportunity lost reasons on seeded old-shape opportunities', () => {
  it('seeds defaults only for tenants that need them, backfills lost opportunities, leaves others untouched, and is idempotent', async () => {
    const url = ownerUrl();
    await migrateBefore0090(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      // Tenant A already has lost-reason options (defaults + one custom option).
      const a = await createTenantWithEntity(pool);
      // Tenant B has lost opportunities and NO lost-reason options yet.
      const b = await createTenantWithEntity(pool);
      // Tenant C has NO lost-reason options and NO lost opportunities (must stay untouched).
      const c = await createTenantWithEntity(pool);

      await inTx(pool, a, async (client) => {
        for (const [key, label, position] of DEFAULT_TUPLES) {
          await client.query(
            `INSERT INTO app.lead_lost_reasons (tenant_id, label, label_norm, position, default_key)
             VALUES ($1, $2, lower($2), $3, $4)`,
            [a.tenantId, label, position, key],
          );
        }
        await client.query(
          `INSERT INTO app.lead_lost_reasons (tenant_id, label, label_norm, position, default_key)
           VALUES ($1, 'Vendor lock-in', 'vendor lock-in', 7, NULL)`,
          [a.tenantId],
        );
      });

      const custA = await seedCustomer(pool, a);
      const custB = await seedCustomer(pool, b);
      const custC = await seedCustomer(pool, c);

      const seedOpps = async (
        t: { tenantId: string; organizationId: string },
        customerId: string,
        rows: [string, string, string | null, string | null][],
      ) =>
        inTx(pool, t, async (client) => {
          const ids: string[] = [];
          for (const [number, stage, reason, note] of rows) {
            const { rows: out } = await client.query<{ id: string }>(
              `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id,
                                              stage, stage_reason, stage_note)
               VALUES ($1, $2, $3, 'Deal', $4, $5, $6, $7) RETURNING id`,
              [t.tenantId, t.organizationId, number, customerId, stage, reason, note],
            );
            ids.push(out[0]!.id);
          }
          return ids;
        });

      const [exact, spaced, key, custom, other, open, held] = await seedOpps(a, custA, [
        ['DEAL-1', 'lost', 'Price', 'Too dear'],
        ['DEAL-2', 'lost', '  chose a COMPETITOR ', 'Went with X'],
        ['DEAL-3', 'lost', 'no_budget', 'Went quiet'],
        ['DEAL-4', 'lost', '  vendor lock-in ', 'Stuck in contract'],
        ['DEAL-5', 'lost', 'Pricing was too high', 'Asked twice'],
        ['DEAL-6', 'qualified', null, null],
        ['DEAL-7', 'on_hold', 'Waiting on board', 'Check Q3'],
      ]);
      const [bMatched, bOther] = await seedOpps(b, custB, [
        ['DEAL-1', 'lost', 'Timing', 'Next year'],
        ['DEAL-2', 'lost', 'Scope changed', 'Revisit later'],
      ]);
      const [cOpen] = await seedOpps(c, custC, [['DEAL-1', 'qualified', null, null]]);

      await runMigrations(url);

      // Tenant B (no options yet, has lost opportunities) received the seven default options.
      const bOptions = await pool.query<{ label: string; position: number }>(
        'SELECT label, position FROM app.lead_lost_reasons WHERE tenant_id = $1 ORDER BY position',
        [b.tenantId],
      );
      expect(bOptions.rows.map((r) => r.label)).toEqual(DEFAULTS);
      expect(bOptions.rows.map((r) => r.position)).toEqual([0, 1, 2, 3, 4, 5, 6]);

      // Tenant A kept its 8 existing options; Tenant C (no lost opportunities) stayed untouched.
      const aOptions = await pool.query(
        'SELECT id FROM app.lead_lost_reasons WHERE tenant_id = $1',
        [a.tenantId],
      );
      expect(aOptions.rows).toHaveLength(8);
      const cOptions = await pool.query(
        'SELECT id FROM app.lead_lost_reasons WHERE tenant_id = $1',
        [c.tenantId],
      );
      expect(cOptions.rows).toHaveLength(0);

      const allIds = [exact, spaced, key, custom, other, open, held, bMatched, bOther, cOpen];
      const readOpps = async () => {
        const { rows } = await pool.query<{
          id: string;
          lost_reason_id: string | null;
          label: string | null;
          stage_reason: string | null;
          stage_note: string | null;
          version: number;
        }>(
          `SELECT op.id, op.lost_reason_id, r.label, op.stage_reason, op.stage_note, op.version
             FROM app.opportunities op
             LEFT JOIN app.lead_lost_reasons r
               ON r.tenant_id = op.tenant_id AND r.id = op.lost_reason_id
            WHERE op.id = ANY($1)`,
          [allIds],
        );
        return new Map(rows.map((r) => [r.id, r]));
      };

      const by = await readOpps();
      expect(by.get(exact!)).toMatchObject({
        label: 'Price',
        stage_reason: 'Price',
        stage_note: 'Too dear',
        version: 2,
      });
      expect(by.get(spaced!)).toMatchObject({
        label: 'Chose a competitor',
        stage_reason: 'Chose a competitor',
        stage_note: 'Went with X',
        version: 2,
      });
      expect(by.get(key!)).toMatchObject({
        label: 'No budget',
        stage_reason: 'No budget',
        stage_note: 'Went quiet',
        version: 2,
      });
      expect(by.get(custom!)).toMatchObject({
        label: 'Vendor lock-in',
        stage_reason: 'Vendor lock-in',
        stage_note: 'Stuck in contract',
        version: 2,
      });
      expect(by.get(other!)).toMatchObject({
        label: 'Other',
        stage_reason: 'Other',
        stage_note: 'Reason given: Pricing was too high\nAsked twice',
        version: 2,
      });
      expect(by.get(open!)).toMatchObject({
        lost_reason_id: null,
        label: null,
        stage_reason: null,
        stage_note: null,
        version: 1,
      });
      expect(by.get(held!)).toMatchObject({
        lost_reason_id: null,
        label: null,
        stage_reason: 'Waiting on board',
        stage_note: 'Check Q3',
        version: 1,
      });
      expect(by.get(bMatched!)).toMatchObject({
        label: 'Timing',
        stage_reason: 'Timing',
        stage_note: 'Next year',
        version: 2,
      });
      expect(by.get(bOther!)).toMatchObject({
        label: 'Other',
        stage_reason: 'Other',
        stage_note: 'Reason given: Scope changed\nRevisit later',
        version: 2,
      });
      expect(by.get(cOpen!)).toMatchObject({
        lost_reason_id: null,
        label: null,
        stage_reason: null,
        stage_note: null,
        version: 1,
      });

      // Audit trail: every migrated opportunity and Tenant B's 7 seeded options carry system:migration-0091.
      const auditedOpps = await pool.query<{ entity_id: string }>(
        `SELECT DISTINCT entity_id FROM audit.audit_events
          WHERE actor_id = $1 AND entity_type = 'opportunities'`,
        [ACTOR],
      );
      expect(auditedOpps.rows.map((r) => r.entity_id).sort()).toEqual(
        [exact, spaced, key, custom, other, bMatched, bOther].sort(),
      );

      const auditedOptions = await pool.query<{ tenant_id: string }>(
        `SELECT tenant_id FROM audit.audit_events
          WHERE actor_id = $1 AND entity_type = 'lead_lost_reasons'`,
        [ACTOR],
      );
      expect(auditedOptions.rows).toHaveLength(7);
      expect(auditedOptions.rows.every((r) => r.tenant_id === b.tenantId)).toBe(true);

      const tenantCAudit = await pool.query(
        'SELECT id FROM audit.audit_events WHERE actor_id = $1 AND tenant_id = $2',
        [ACTOR, c.tenantId],
      );
      expect(tenantCAudit.rows).toHaveLength(0);

      // Idempotent re-run of 0091 changes nothing and writes no additional audit events.
      const auditCountBefore = Number(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM audit.audit_events WHERE actor_id = $1',
            [ACTOR],
          )
        ).rows[0]!.n,
      );
      const sql0091 = readFileSync(
        join(MIGRATIONS_FOLDER, '0091_opportunity_lost_reason_data.sql'),
        'utf8',
      );
      const statements = sql0091
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter((part) => part.length > 0);
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        for (const stmt of statements) await client.query(stmt);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }

      const afterRerun = await readOpps();
      for (const id of allIds) {
        expect(afterRerun.get(id!)).toEqual(by.get(id!));
      }
      const auditCountAfter = Number(
        (
          await pool.query<{ n: string }>(
            'SELECT count(*)::text AS n FROM audit.audit_events WHERE actor_id = $1',
            [ACTOR],
          )
        ).rows[0]!.n,
      );
      expect(auditCountAfter).toBe(auditCountBefore);
    } finally {
      await pool.end();
    }
  });
});
