// Integration test for migration 0092 (D50): a historic lead whose creator 0080 left NULL gets the user its
// `lead.created` audit event names, and nothing else changes.
// Needs Docker: a real postgres:16-alpine from Testcontainers (its own database, so no compose stack is
// involved). Run with:
//   pnpm --filter @bos/db exec vitest run src/lead-creator-backfill-migration.test.ts
//
// The database is migrated with the real SQL up to 0091, given leads with no creator and `lead.created` events
// written the way the API writes them (audit.record under the request's actor), then migrated with the real
// runner, which applies 0092 and anything later.
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
const TAG = '0092_lead_creator_backfill';
const ACTOR = 'system:migration-0092';

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Actor {
  kind: 'user' | 'system' | 'seed';
  id: string;
}

const SYSTEM: Actor = { kind: 'system', id: 'lead-creator-migration-test' };

let container: StartedPostgreSqlContainer;
let admin: Pool;
let owner: Pool;
let beforeFolder: string;
let sql0092: string[];

let tenant: TenantWithEntity;
let other: TenantWithEntity;
let userA: string;
let userB: string;
let outsider: string;

const lead = {} as {
  filled: string;
  sameActorTwice: string;
  alreadySet: string;
  ambiguous: string;
  knownAndUnknown: string;
  otherTenantActor: string;
  nonUserActor: string;
  unknownActor: string;
  noEvent: string;
};

/** One transaction as bos_owner in `scope`, with the audit settings the triggers and audit.record demand. */
async function writeAs<T>(
  scope: TenantWithEntity,
  actor: Actor,
  fn: (client: PoolClient) => Promise<T>,
): Promise<T> {
  const client = await owner.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', $1, true),
              set_config('bos.actor_id', $2, true),
              set_config('bos.correlation_id', $3, true),
              set_config('bos.tenant_id', $4, true),
              set_config('bos.organization_id', $5, true)`,
      [actor.kind, actor.id, randomUUID(), scope.tenantId, scope.organizationId],
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

async function insertLead(createdByUserId: string | null = null): Promise<string> {
  return writeAs(tenant, SYSTEM, async (c) => {
    const { rows } = await c.query<{ id: string }>(
      `INSERT INTO app.leads
         (tenant_id, organization_id, number, title, source, owner_user_id, company_name, contact_name, created_by_user_id)
       VALUES ($1, $2, $3, 'Lead', 'website', $4, 'Acme', 'Asha', $5) RETURNING id`,
      [
        tenant.tenantId,
        tenant.organizationId,
        `LD-${randomUUID().slice(0, 8)}`,
        userB,
        createdByUserId,
      ],
    );
    return rows[0]!.id;
  });
}

/** A `lead.created` event for `leadId` in the lead's tenant, recorded under `actor` as the API does. */
async function recordCreated(leadId: string, actor: Actor): Promise<void> {
  await writeAs(tenant, actor, (c) =>
    c.query(`SELECT audit.record('lead.created', 'leads', $1, NULL, $2::jsonb, NULL)`, [
      leadId,
      JSON.stringify({ stage: 'new' }),
    ]),
  );
}

async function creators(): Promise<Map<string, string | null>> {
  const { rows } = await owner.query<{ id: string; created_by_user_id: string | null }>(
    'SELECT id, created_by_user_id FROM app.leads WHERE tenant_id = $1',
    [tenant.tenantId],
  );
  return new Map(rows.map((row) => [row.id, row.created_by_user_id]));
}

async function migrationEvents(): Promise<number> {
  const { rows } = await owner.query<{ n: string }>(
    'SELECT count(*) AS n FROM audit.audit_events WHERE actor_id = $1',
    [ACTOR],
  );
  return Number(rows[0]!.n);
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
  beforeFolder = await mkdtemp(join(tmpdir(), 'bos-before-0092-'));
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
  sql0092 = (await readFile(join(MIGRATIONS_FOLDER, `${TAG}.sql`), 'utf8')).split(
    '--> statement-breakpoint',
  );
  await runMigrations(ownerUrl, beforeFolder);

  tenant = await createTenantWithEntity(owner);
  other = await createTenantWithEntity(owner);
  userA = (await createStaffUser(owner, tenant)).userId;
  userB = (await createStaffUser(owner, tenant)).userId;
  outsider = (await createStaffUser(owner, other)).userId;

  lead.filled = await insertLead();
  await recordCreated(lead.filled, { kind: 'user', id: userA });

  lead.sameActorTwice = await insertLead();
  await recordCreated(lead.sameActorTwice, { kind: 'user', id: userA });
  await recordCreated(lead.sameActorTwice, { kind: 'user', id: userA.toUpperCase() });

  lead.alreadySet = await insertLead(userB);
  await recordCreated(lead.alreadySet, { kind: 'user', id: userA });

  lead.ambiguous = await insertLead();
  await recordCreated(lead.ambiguous, { kind: 'user', id: userA });
  await recordCreated(lead.ambiguous, { kind: 'user', id: userB });

  lead.knownAndUnknown = await insertLead();
  await recordCreated(lead.knownAndUnknown, { kind: 'user', id: userA });
  await recordCreated(lead.knownAndUnknown, { kind: 'user', id: randomUUID() });

  lead.otherTenantActor = await insertLead();
  await recordCreated(lead.otherTenantActor, { kind: 'user', id: outsider });

  // A real user of the tenant as the id, so only the kind keeps it out.
  lead.nonUserActor = await insertLead();
  await recordCreated(lead.nonUserActor, { kind: 'seed', id: userA });

  lead.unknownActor = await insertLead();
  await recordCreated(lead.unknownActor, { kind: 'user', id: randomUUID() });

  lead.noEvent = await insertLead();

  // The real runner now applies 0092 and everything after it.
  await runMigrations(ownerUrl);
}, 180_000);

afterAll(async () => {
  await owner?.end();
  await admin?.end();
  await container?.stop();
  if (beforeFolder) await rm(beforeFolder, { recursive: true, force: true });
});

describe('0092 lead creator backfill', () => {
  it('fills a missing creator with the user its lead.created event names', async () => {
    const after = await creators();
    expect(after.get(lead.filled)).toBe(userA);
    expect(after.get(lead.sameActorTwice)).toBe(userA);
  });

  it('never changes a creator that is already set', async () => {
    expect((await creators()).get(lead.alreadySet)).toBe(userB);
  });

  it('leaves the creator empty when the audit trail names no single known user of the tenant', async () => {
    const after = await creators();
    for (const id of [
      lead.ambiguous,
      lead.knownAndUnknown,
      lead.otherTenantActor,
      lead.nonUserActor,
      lead.unknownActor,
      lead.noEvent,
    ]) {
      expect(after.get(id), id).toBeNull();
    }
  });

  it('records each fill in the audit trail as the migration, without raising the version', async () => {
    const { rows } = await owner.query<{
      before: string | null;
      after: string;
      before_version: string;
      after_version: string;
    }>(
      `SELECT before ->> 'created_by_user_id' AS before, after ->> 'created_by_user_id' AS after,
              before ->> 'version' AS before_version, after ->> 'version' AS after_version
         FROM audit.audit_events
        WHERE entity_type = 'leads' AND action = 'leads.update' AND entity_id = $1 AND actor_id = $2`,
      [lead.filled, ACTOR],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ before: null, after: userA });
    expect(rows[0]!.after_version).toBe(rows[0]!.before_version);
    expect(await migrationEvents()).toBe(2);
  });

  it('finds nothing to fill when it runs again', async () => {
    const before = await creators();
    const eventsBefore = await migrationEvents();
    const client = await owner.connect();
    try {
      await client.query('BEGIN');
      for (const statement of sql0092) await client.query(statement);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    expect(await creators()).toEqual(before);
    expect(await migrationEvents()).toBe(eventsBefore);
  });
});
