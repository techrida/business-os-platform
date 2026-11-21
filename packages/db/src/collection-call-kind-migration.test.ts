// Integration test for migration 0154_collection_call_kind (R4c1 Q1): the activities a payment promise names as its
// collection call (payment_promises.collection_activity_id) become kind `collection_call`, open and completed alike,
// with the version moved and the change audited as system:migration-0154; a plain call no promise names stays a
// call; the new kind passes activities_kind_check.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/collection-call-kind-migration.test.ts
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Pool, type PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { MIGRATIONS_FOLDER, runMigrations } from './migrate.js';
import {
  createParty,
  createStaffUser,
  createTenantWithEntity,
  type TenantWithEntity,
} from './testing/fixtures.js';
import { createTestDatabase, type TestDatabase } from './testing/test-database.js';

const TAG = '0154_collection_call_kind';
const ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
let url: string;
let folder: string;
let org: TenantWithEntity;
const ids = { openCall: '', doneCall: '', plainCall: '' };

/** One transaction on the owner pool, as a system actor acting in `org`'s entity (the audit trigger needs both). */
async function asSystem<T>(fn: (c: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'collection-call-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.organization_id', $2, true)`,
      [randomUUID(), org.organizationId],
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

/** Seeds, before 0154: an invoice with two missed promises (one open call, one completed) and an unrelated call. */
async function seed(): Promise<void> {
  const { userId } = await createStaffUser(pool, { ...org, roleKeys: ['finance'] });
  const { partyId: customer } = await createParty(pool, {
    tenantId: org.tenantId,
    kind: 'customer',
  });
  await asSystem(async (c) => {
    await c.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
      [customer, org.tenantId, `CUS-${customer.slice(0, 8)}`, ADDRESS],
    );
    const invoice = await c.query<{ id: string }>(
      `INSERT INTO app.invoices (tenant_id, organization_id, kind, customer_party_id, manual_reason, currency)
       VALUES ($1, $2, 'tax_invoice', $3, 'One-off', 'NPR') RETURNING id`,
      [org.tenantId, org.organizationId, customer],
    );
    const call = async (completed: boolean) =>
      (
        await c.query<{ id: string }>(
          `INSERT INTO app.activities
             (tenant_id, organization_id, kind, subject, customer_id, due_at, assignee_user_id, completed_at)
           VALUES ($1, $2, 'call', 'Collect payment for INV-1', $3, now(), $4, $5) RETURNING id`,
          [org.tenantId, org.organizationId, customer, userId, completed ? new Date() : null],
        )
      ).rows[0]!.id;
    ids.openCall = await call(false);
    ids.doneCall = await call(true);
    ids.plainCall = await call(false);
    for (const activityId of [ids.openCall, ids.doneCall]) {
      await c.query(
        `INSERT INTO app.payment_promises
           (tenant_id, organization_id, invoice_id, promised_date, status, recorded_by_user_id, missed_at,
            collection_activity_id)
         VALUES ($1, $2, $3, '2026-11-01', 'missed', $4, now(), $5)`,
        [org.tenantId, org.organizationId, invoice.rows[0]!.id, userId, activityId],
      );
    }
  });
}

async function kinds(): Promise<Record<string, { kind: string; version: number }>> {
  const { rows } = await pool.query<{ id: string; kind: string; version: number }>(
    'SELECT id, kind, version FROM app.activities WHERE tenant_id = $1',
    [org.tenantId],
  );
  return Object.fromEntries(rows.map((r) => [r.id, { kind: r.kind, version: r.version }]));
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  url = testDb.ownerUrl;
  pool = new Pool({ connectionString: url, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const index = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(index, `${TAG} is in the journal`).toBeGreaterThan(0);
  folder = await mkdtemp(join(tmpdir(), 'bos-before-0154-'));
  await mkdir(join(folder, 'meta'));
  const before = journal.entries.slice(0, index);
  await writeFile(
    join(folder, 'meta/_journal.json'),
    JSON.stringify({ ...journal, entries: before }),
  );
  for (const entry of before) {
    await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
  }
  await runMigrations(url, folder);

  org = await createTenantWithEntity(pool);
  await seed();
  await runMigrations(url, MIGRATIONS_FOLDER);
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  if (folder !== undefined) await rm(folder, { recursive: true, force: true });
});

describe('0154 collection_call', () => {
  it('turns every call a payment promise names into a collection call, open or done, and moves its version', async () => {
    const after = await kinds();
    expect(after[ids.openCall]).toEqual({ kind: 'collection_call', version: 2 });
    expect(after[ids.doneCall]).toEqual({ kind: 'collection_call', version: 2 });
  });

  it('leaves a call no promise names as a call', async () => {
    expect((await kinds())[ids.plainCall]).toEqual({ kind: 'call', version: 1 });
  });

  it('audits the change as the migration', async () => {
    const { rows } = await pool.query<{ entity_id: string; actor_id: string }>(
      `SELECT entity_id, actor_id FROM audit.audit_events
        WHERE tenant_id = $1 AND entity_type = 'activities' AND after ->> 'kind' = 'collection_call'
        ORDER BY entity_id`,
      [org.tenantId],
    );
    expect(rows).toEqual(
      [ids.openCall, ids.doneCall]
        .sort()
        .map((id) => ({ entity_id: id, actor_id: 'system:migration-0154' })),
    );
  });

  it('accepts the new kind and still refuses an unknown one', async () => {
    const write = (kind: string) =>
      asSystem((c) =>
        c.query(
          `INSERT INTO app.activities (tenant_id, organization_id, kind, subject, customer_id)
           SELECT tenant_id, organization_id, $2, 'Collect', customer_id FROM app.activities WHERE id = $1`,
          [ids.plainCall, kind],
        ),
      );
    await expect(write('collection_call')).resolves.toBeDefined();
    await expect(write('fax')).rejects.toMatchObject({ code: '23514' });
  });
});
