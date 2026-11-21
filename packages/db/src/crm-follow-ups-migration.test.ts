// Migrations 0062-0063 (one model for follow-ups, D39) on real Postgres: rows written in the old shape (a lead's
// next_follow_up_at, task activities) become planned or logged activities, and the moves are audited.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDb } from './client.js';
import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import { createParty, createStaffUser, createTenantWithEntity } from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const ACTOR = 'system:migration-0063';

let testDb: TestDatabase;

beforeAll(async () => {
  // Unmigrated: the test migrates to just before 0062 itself.
  testDb = await createTestDatabase({ migrated: false });
});

afterAll(async () => {
  await testDb?.drop();
});

/**
 * Migrates to the last migration before 0062: a copy of the folder with the journal cut by file number, not idx
 * (other units' 0048-0061 are renumbered on merge and still belong before this one).
 */
async function migrateBefore0062(url: string): Promise<void> {
  const folder = mkdtempSync(join(tmpdir(), 'bos-pre-0062-'));
  try {
    cpSync(MIGRATIONS_FOLDER, folder, { recursive: true });
    const journalPath = join(folder, 'meta', '_journal.json');
    const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as {
      entries: { tag: string }[];
    };
    journal.entries = journal.entries.filter((e) => Number(e.tag.slice(0, 4)) < 62);
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

/** One transaction with the bos.* settings withTx() sets, so the audit triggers accept the seed rows. */
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
      'bos.actor_id': 'follow-ups-migration-test',
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

/** The counts 0063 RAISE NOTICEs, read by the same rules. */
async function counts(pool: Pool, tenantId: string) {
  const { rows } = await pool.query<Record<string, string>>(
    `SELECT
       (SELECT count(*) FROM app.leads WHERE tenant_id = $1 AND next_follow_up_at IS NOT NULL) AS lead_follow_ups,
       count(*) FILTER (WHERE kind = 'task') AS tasks,
       count(*) FILTER (WHERE kind = 'task' AND completed_at IS NOT NULL) AS tasks_completed,
       count(*) FILTER (WHERE kind = 'task' AND completed_at IS NULL) AS tasks_open,
       count(*) FILTER (WHERE kind <> 'task' AND due_at IS NOT NULL AND completed_at IS NULL) AS other_due_open,
       count(*) FILTER (WHERE kind IN ('call', 'meeting', 'email') AND due_at IS NOT NULL
                          AND completed_at IS NULL) AS planned,
       count(*) AS activities
     FROM app.activities WHERE tenant_id = $1`,
    [tenantId],
  );
  return Object.fromEntries(Object.entries(rows[0] ?? {}).map(([k, v]) => [k, Number(v)]));
}

describe('0062-0063 follow-ups on seeded old-shape rows', () => {
  it('turns lead follow-ups and tasks into planned or logged calls, audited as the migration', async () => {
    const url = testDb.ownerUrl;
    await migrateBefore0062(url);
    const pool = new Pool({ connectionString: url, max: 2 });
    try {
      const { tenantId, organizationId, idpOrgId } = await createTenantWithEntity(pool);
      const { userId: ownerId } = await createStaffUser(pool, {
        tenantId,
        organizationId,
        idpOrgId,
      });
      const scope = { tenantId, organizationId };
      // A converted lead needs a customer and an opportunity to point at (leads_converted_check).
      const { partyId: customerId } = await createParty(pool, { tenantId, kind: 'customer' });
      const dueOwned = '2026-12-01T09:00:00.000Z';
      const dueUnowned = '2026-12-02T09:00:00.000Z';
      const occurred = '2026-11-01T08:00:00.000Z';
      const completed = '2026-11-02T08:00:00.000Z';
      const taskDue = '2026-11-20T10:00:00.000Z';

      const seed = await inTx(pool, scope, async (c) => {
        const lead = async (
          number: string,
          owner: string | null,
          followUp: string | null,
          closed: {
            stage: string;
            stage_reason?: string;
            stage_note?: string;
            customer_id?: string;
            converted_opportunity_id?: string;
          } = { stage: 'new' },
        ) => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, owner_user_id,
                                    company_name, contact_name, next_follow_up_at, stage, stage_reason,
                                    stage_note, customer_id, converted_opportunity_id)
             VALUES ($1, $2, $3, 'Lead', 'website', $4, 'Acme', 'Asha', $5, $6, $7, $8, $9, $10) RETURNING id`,
            [
              tenantId,
              organizationId,
              number,
              owner,
              followUp,
              closed.stage,
              closed.stage_reason ?? null,
              closed.stage_note ?? null,
              closed.customer_id ?? null,
              closed.converted_opportunity_id ?? null,
            ],
          );
          return rows[0]!.id;
        };
        await c.query(
          `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
           VALUES ($1, $2, 'CUS-1', 'Acme Pvt. Ltd.', 'acme', $3::jsonb)`,
          [
            customerId,
            tenantId,
            JSON.stringify({ line1: '1 Durbar Marg', city: 'Kathmandu', country: 'NP' }),
          ],
        );
        const { rows: deal } = await c.query<{ id: string }>(
          `INSERT INTO app.opportunities (tenant_id, organization_id, number, name, customer_id)
           VALUES ($1, $2, 'DEAL-1', 'Acme deal', $3) RETURNING id`,
          [tenantId, organizationId, customerId],
        );
        const activity = async (
          kind: string,
          leadId: string,
          fields: { dueAt?: string; completedAt?: string },
        ) => {
          const { rows } = await c.query<{ id: string }>(
            `INSERT INTO app.activities (tenant_id, organization_id, kind, subject, lead_id, due_at,
                                         completed_at, occurred_at, assignee_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              tenantId,
              organizationId,
              kind,
              `${kind} subject`,
              leadId,
              fields.dueAt ?? null,
              fields.completedAt ?? null,
              occurred,
              ownerId,
            ],
          );
          return rows[0]!.id;
        };
        const owned = await lead('LD-1', ownerId, dueOwned);
        const unowned = await lead('LD-2', null, dueUnowned);
        const plain = await lead('LD-3', ownerId, null);
        // Closed leads with a stale follow-up: the column is cleared, but no call is planned for them.
        const lost = await lead('LD-4', ownerId, dueOwned, {
          stage: 'lost',
          stage_reason: 'no_budget',
          stage_note: 'Went quiet',
        });
        const converted = await lead('LD-5', ownerId, dueOwned, {
          stage: 'converted',
          customer_id: customerId,
          converted_opportunity_id: deal[0]!.id,
        });
        return {
          owned,
          unowned,
          plain,
          lost,
          converted,
          taskCompleted: await activity('task', plain, { dueAt: taskDue, completedAt: completed }),
          taskOpenDue: await activity('task', plain, { dueAt: taskDue }),
          taskOpenNoDue: await activity('task', plain, {}),
          openCall: await activity('call', plain, { dueAt: taskDue }),
          note: await activity('note', plain, {}),
        };
      });

      expect(await counts(pool, tenantId)).toEqual({
        lead_follow_ups: 4,
        tasks: 3,
        tasks_completed: 1,
        tasks_open: 2,
        other_due_open: 1,
        planned: 1,
        activities: 5,
      });
      const untouched = await pool.query(
        `SELECT * FROM app.activities WHERE id = ANY($1) ORDER BY id`,
        [[seed.openCall, seed.note]],
      );

      await runMigrations(url);

      // Two calls inserted from the open leads (none for the lost and converted ones, whose column is still
      // cleared); all three tasks are calls; 2 + 2 open tasks + the open call planned.
      expect(await counts(pool, tenantId)).toEqual({
        lead_follow_ups: 0,
        tasks: 0,
        tasks_completed: 0,
        tasks_open: 0,
        other_due_open: 5,
        planned: 5,
        activities: 7,
      });

      const fromLeads = await pool.query<{
        lead_id: string;
        kind: string;
        subject: string;
        due_at: Date;
        assignee_user_id: string | null;
        completed_at: Date | null;
        cancelled_at: Date | null;
        created_by_user_id: string | null;
      }>(
        `SELECT lead_id, kind, subject, due_at, assignee_user_id, completed_at, cancelled_at, created_by_user_id
           FROM app.activities WHERE lead_id = ANY($1) ORDER BY due_at`,
        [[seed.owned, seed.unowned]],
      );
      expect(fromLeads.rows).toEqual([
        {
          lead_id: seed.owned,
          kind: 'call',
          subject: 'Follow up',
          due_at: new Date(dueOwned),
          assignee_user_id: ownerId,
          completed_at: null,
          cancelled_at: null,
          created_by_user_id: null,
        },
        {
          lead_id: seed.unowned,
          kind: 'call',
          subject: 'Follow up',
          due_at: new Date(dueUnowned),
          assignee_user_id: null,
          completed_at: null,
          cancelled_at: null,
          created_by_user_id: null,
        },
      ]);

      const tasks = await pool.query<{
        id: string;
        kind: string;
        due_at: Date | null;
        completed_at: Date | null;
        occurred_at: Date;
      }>(
        'SELECT id, kind, due_at, completed_at, occurred_at FROM app.activities WHERE id = ANY($1)',
        [[seed.taskCompleted, seed.taskOpenDue, seed.taskOpenNoDue]],
      );
      const byId = new Map(tasks.rows.map((row) => [row.id, row]));
      // Completed: logged, its times kept.
      expect(byId.get(seed.taskCompleted)).toMatchObject({
        kind: 'call',
        due_at: new Date(taskDue),
        completed_at: new Date(completed),
        occurred_at: new Date(occurred),
      });
      // Open with due_at: planned at the same time.
      expect(byId.get(seed.taskOpenDue)).toMatchObject({
        kind: 'call',
        due_at: new Date(taskDue),
        completed_at: null,
      });
      // Open without due_at: planned at occurred_at, so it shows as overdue.
      expect(byId.get(seed.taskOpenNoDue)).toMatchObject({
        kind: 'call',
        due_at: new Date(occurred),
        completed_at: null,
      });

      // Other kinds are left as they were (0062 only adds the two NULL columns).
      const after = await pool.query(
        `SELECT * FROM app.activities WHERE id = ANY($1) ORDER BY id`,
        [[seed.openCall, seed.note]],
      );
      expect(after.rows).toEqual(
        untouched.rows.map((row: Record<string, unknown>) => ({
          ...row,
          cancelled_at: null,
          created_by_user_id: null,
        })),
      );

      // The lost and converted leads got no activity at all.
      const closedActivities = await pool.query(
        'SELECT id FROM app.activities WHERE lead_id = ANY($1)',
        [[seed.lost, seed.converted]],
      );
      expect(closedActivities.rows).toEqual([]);

      // Audit: every converted or inserted row and all four cleared leads, as the migration; nothing else.
      const audited = await pool.query<{ entity_id: string }>(
        'SELECT DISTINCT entity_id FROM audit.audit_events WHERE tenant_id = $1 AND actor_id = $2',
        [tenantId, ACTOR],
      );
      const fromLeadIds = await pool.query<{ id: string }>(
        'SELECT id FROM app.activities WHERE lead_id = ANY($1)',
        [[seed.owned, seed.unowned]],
      );
      expect(audited.rows.map((row) => row.entity_id).sort()).toEqual(
        [
          seed.owned,
          seed.unowned,
          seed.lost,
          seed.converted,
          seed.taskCompleted,
          seed.taskOpenDue,
          seed.taskOpenNoDue,
          ...fromLeadIds.rows.map((row) => row.id),
        ].sort(),
      );
    } finally {
      await pool.end();
    }
  });
});
