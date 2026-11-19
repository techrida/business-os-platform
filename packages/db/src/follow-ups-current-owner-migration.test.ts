// Integration test for migration 0089 (D54-1): planned follow-ups an owner change made before D45 left with the
// lead's previous owner move to its current owner, and nothing else moves.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/follow-ups-current-owner-migration.test.ts
//
// The database is migrated with the real SQL up to 0088, given leads whose owners changed the way they did before
// D45 (a plain UPDATE: only the row audit records it) and after D45 (the same UPDATE plus a lead.owner_changed
// event in the same correlation), then migrated with the real runner, which applies 0089 and anything later.
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';

const OWNER_PW = 'owner-test-pw';
const TAG = '0089_follow_ups_to_current_owner';
const DUE = '2026-12-01T09:00:00Z';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface ActivityState {
  assignee_user_id: string | null;
  version: number;
}

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0089: string[];

let tenant: TenantWithEntity;
let userA: string;
let userB: string;
let userC: string;

/** Lead 1: owner A, changed to B before D45. */
const lead1 = {} as {
  id: string;
  openA: string;
  openC: string;
  completedA: string;
  cancelledA: string;
  noteA: string;
  unassigned: string;
  createdAfterA: string;
  reassignedBackA: string;
};
/** Lead 2: owner A, changed to B the D45 way (a lead.owner_changed event in the same correlation). */
const lead2 = {} as { id: string; openA: string };
/** Lead 3: owner A, owner removed before D45. */
const lead3 = {} as { id: string; openA: string };
/** Lead 4: owner A, then B, then C, all before D45. */
const lead4 = {} as { id: string; openA: string; openB: string };

let statesBefore: Map<string, ActivityState>;

/** One transaction as bos_owner with the audit settings the triggers and audit.record demand. */
async function writeAs<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'follow-ups-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.tenant_id', $2, true),
              set_config('bos.organization_id', $3, true)`,
      [randomUUID(), tenant.tenantId, tenant.organizationId],
    );
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

async function insertLead(ownerUserId: string): Promise<string> {
  return writeAs(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.leads (tenant_id, organization_id, number, title, source, owner_user_id, company_name, contact_name)
       VALUES ($1, $2, $3, 'Lead', 'website', $4, 'Acme', 'Asha') RETURNING id`,
      [tenant.tenantId, tenant.organizationId, `LD-${randomUUID().slice(0, 8)}`, ownerUserId],
    );
    return rows[0]!.id;
  });
}

/** A follow-up on `leadId`: a planned call unless `extra` completes or cancels it, or `kind` is not schedulable. */
async function insertActivity(
  leadId: string,
  assigneeUserId: string | null,
  options: { kind?: string; completed?: boolean; cancelled?: boolean } = {},
): Promise<string> {
  return writeAs(async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.activities
         (tenant_id, organization_id, kind, subject, lead_id, due_at, assignee_user_id, completed_at, cancelled_at)
       VALUES ($1, $2, $3, 'Follow up', $4, $5, $6, $7, $8) RETURNING id`,
      [
        tenant.tenantId,
        tenant.organizationId,
        options.kind ?? 'call',
        leadId,
        DUE,
        assigneeUserId,
        options.completed ? new Date() : null,
        options.cancelled ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  });
}

/** An owner change as the code made it before D45: the UPDATE alone. */
async function changeOwnerBeforeD45(leadId: string, to: string | null): Promise<void> {
  await writeAs((c) => c.query('UPDATE app.leads SET owner_user_id = $2 WHERE id = $1', [leadId, to]));
}

/** An owner change as D45 makes it: the UPDATE and a lead.owner_changed event, in one transaction. */
async function changeOwnerD45(leadId: string, from: string, to: string): Promise<void> {
  await writeAs(async (c) => {
    await c.query('UPDATE app.leads SET owner_user_id = $2 WHERE id = $1', [leadId, to]);
    await c.query(
      `SELECT audit.record('lead.owner_changed', 'leads', $1, $2::jsonb, $3::jsonb, NULL)`,
      [leadId, JSON.stringify({ ownerUserId: from }), JSON.stringify({ ownerUserId: to })],
    );
  });
}

async function reassign(activityId: string, to: string): Promise<void> {
  await writeAs((c) =>
    c.query(
      'UPDATE app.activities SET assignee_user_id = $2, version = version + 1 WHERE id = $1',
      [activityId, to],
    ),
  );
}

async function states(): Promise<Map<string, ActivityState>> {
  const { rows } = await owner.query<ActivityState & { id: string }>(
    'SELECT id, assignee_user_id, version FROM app.activities WHERE tenant_id = $1',
    [tenant.tenantId],
  );
  return new Map(
    rows.map((row) => [row.id, { assignee_user_id: row.assignee_user_id, version: row.version }]),
  );
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();
  admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query('CREATE ROLE bos_app');
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  const url = new URL(container.getConnectionUri());
  url.username = 'bos_owner';
  url.password = OWNER_PW;
  url.pathname = '/bos';
  const ownerUrl = url.toString();
  owner = new Pool({ connectionString: ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0089-'));
  await mkdir(join(beforeFolder, 'meta'));
  const entries = journal.entries.slice(0, index);
  await writeFile(
    join(beforeFolder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries }),
  );
  for (const entry of entries) {
    await copyFile(
      join(MIGRATIONS_FOLDER, `${entry.tag}.sql`),
      join(beforeFolder, `${entry.tag}.sql`),
    );
  }
  sql0089 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenant = await createTenantWithEntity(owner);
  userA = (await createStaffUser(owner, tenant)).userId;
  userB = (await createStaffUser(owner, tenant)).userId;
  userC = (await createStaffUser(owner, tenant)).userId;

  lead1.id = await insertLead(userA);
  lead1.openA = await insertActivity(lead1.id, userA);
  lead1.openC = await insertActivity(lead1.id, userC);
  lead1.completedA = await insertActivity(lead1.id, userA, { completed: true });
  lead1.cancelledA = await insertActivity(lead1.id, userA, { cancelled: true });
  lead1.noteA = await insertActivity(lead1.id, userA, { kind: 'note' });
  lead1.unassigned = await insertActivity(lead1.id, null);
  lead1.reassignedBackA = await insertActivity(lead1.id, userA);
  await changeOwnerBeforeD45(lead1.id, userB);
  // After the change: a follow-up given to A on purpose, and one someone moved away from A and back.
  lead1.createdAfterA = await insertActivity(lead1.id, userA);
  await reassign(lead1.reassignedBackA, userC);
  await reassign(lead1.reassignedBackA, userA);

  lead2.id = await insertLead(userA);
  lead2.openA = await insertActivity(lead2.id, userA);
  await changeOwnerD45(lead2.id, userA, userB);

  lead3.id = await insertLead(userA);
  lead3.openA = await insertActivity(lead3.id, userA);
  await changeOwnerBeforeD45(lead3.id, null);

  lead4.id = await insertLead(userA);
  lead4.openA = await insertActivity(lead4.id, userA);
  await changeOwnerBeforeD45(lead4.id, userB);
  lead4.openB = await insertActivity(lead4.id, userB);
  await changeOwnerBeforeD45(lead4.id, userC);

  statesBefore = await states();
  // The real runner now applies 0089 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0089 follow-ups to the current owner', () => {
  it('moves the planned follow-up a pre-D45 owner change left with the old owner, raising its version', async () => {
    const after = await states();
    expect(after.get(lead1.openA)).toEqual({
      assignee_user_id: userB,
      version: statesBefore.get(lead1.openA)!.version + 1,
    });
  });

  it('moves every follow-up left behind along a chain of changes to the owner the lead has now', async () => {
    const after = await states();
    expect(after.get(lead4.openA)?.assignee_user_id).toBe(userC);
    expect(after.get(lead4.openB)?.assignee_user_id).toBe(userC);
  });

  it('leaves everything else exactly as it was', async () => {
    const after = await states();
    const moved = new Set([lead1.openA, lead4.openA, lead4.openB]);
    const unchanged = [...statesBefore.keys()].filter((id) => !moved.has(id));
    // Assigned to someone else, completed, cancelled, a note, unassigned, assigned after the change, reassigned
    // after the change, a D45 change, and a lead without an owner.
    for (const id of [
      lead1.openC,
      lead1.completedA,
      lead1.cancelledA,
      lead1.noteA,
      lead1.unassigned,
      lead1.createdAfterA,
      lead1.reassignedBackA,
      lead2.openA,
      lead3.openA,
    ]) {
      expect(unchanged).toContain(id);
    }
    for (const id of unchanged) expect(after.get(id), id).toEqual(statesBefore.get(id));
  });

  it('records each move in the audit trail as the migration', async () => {
    const { rows } = await owner.query<{ actor_id: string; before: string; after: string }>(
      `SELECT actor_id, before ->> 'assignee_user_id' AS before, after ->> 'assignee_user_id' AS after
         FROM audit.audit_events
        WHERE entity_type = 'activities' AND action = 'activities.update' AND entity_id = $1
        ORDER BY id DESC LIMIT 1`,
      [lead1.openA],
    );
    expect(rows[0]).toEqual({ actor_id: 'system:migration-0089', before: userA, after: userB });
    const { rows: all } = await owner.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE entity_type = 'activities' AND actor_id = 'system:migration-0089'`,
    );
    expect(Number(all[0]!.n)).toBe(3);
  });

  it('finds nothing to move when it runs again', async () => {
    const before = await states();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0089) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await states()).toEqual(before);
  });
});
