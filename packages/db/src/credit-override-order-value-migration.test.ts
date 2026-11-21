// Integration test for migrations 0170 and 0171 (R5 FU4): a credit override is tied to the order value it was given for.
//   * 0170 adds opportunities.credit_override_order_value, which only ever sits beside an override and is never
//     negative.
//   * 0171 fills it for overrides given earlier, from the `orderValue` of the deal's LATEST
//     `opportunity.credit_overridden` audit event; an override whose events carry no value stays null (it covers
//     nothing, so its deal needs a new override); a deal with no override is untouched; the deal's version does not
//     move; the backfill is audited as the migration.
// Migrates only up to the migration before 0170, seeds, then runs 0170 and 0171.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/credit-override-order-value-migration.test.ts
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

const FIRST_TAG = '0170_credit_override_order_value';
const SECOND_TAG = '0171_credit_override_order_value_backfill';
const ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

let testDb: TestDatabase;
let pool: Pool;
let org: TenantWithEntity;
let userId: string;
let customerId: string;
const folders: string[] = [];
const deals: Record<'latest' | 'legacy' | 'plain' | 'quiet', string> = {
  latest: '',
  legacy: '',
  plain: '',
  quiet: '',
};
let quietVersionBefore = 0;

/** Runs fn in one transaction as the audit actor, acting for `org`'s entity; rolls back on a throw. */
async function inTx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'credit-override-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.tenant_id', $2, true),
              set_config('bos.organization_id', $3, true)`,
      [randomUUID(), org.tenantId, org.organizationId],
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

/** A deal of the customer; `overridden` gives it an override (reason, user, time) as 0103 stores one. */
async function deal(overridden: boolean): Promise<string> {
  return inTx(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app.opportunities
         (tenant_id, organization_id, number, name, customer_id,
          credit_override_reason, credit_override_by_user_id, credit_override_at)
       VALUES ($1, $2, $3, 'Acme website', $4, $5, $6, $7) RETURNING id`,
      [
        org.tenantId,
        org.organizationId,
        `DEAL-${randomUUID().slice(0, 8)}`,
        customerId,
        overridden ? 'Director approved' : null,
        overridden ? userId : null,
        overridden ? new Date() : null,
      ],
    );
    return rows[0]!.id;
  });
}

/** The audit event the override action wrote (audit.record, as AuditService.record does). */
async function overrideEvent(opportunityId: string, meta: Record<string, unknown>): Promise<void> {
  await inTx((client) =>
    client.query('SELECT audit.record($1, $2, $3, $4::jsonb, $5::jsonb, $6::jsonb)', [
      'opportunity.credit_overridden',
      'opportunities',
      opportunityId,
      null,
      JSON.stringify({ creditOverrideAt: new Date().toISOString() }),
      JSON.stringify(meta),
    ]),
  );
}

async function stored(id: string) {
  const { rows } = await pool.query<{ value: string | null; version: number }>(
    `SELECT credit_override_order_value AS value, version FROM app.opportunities WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const first = journal.entries.findIndex((entry) => entry.tag === FIRST_TAG);
  expect(first, `${FIRST_TAG} is in the journal`).toBeGreaterThan(0);
  expect(journal.entries[first + 1]?.tag).toBe(SECOND_TAG);
  const folderOf = async (name: string, end: number): Promise<string> => {
    const folder = await mkdtemp(join(tmpdir(), `bos-${name}-`));
    folders.push(folder);
    await mkdir(join(folder, 'meta'));
    const entries = journal.entries.slice(0, end);
    await writeFile(join(folder, 'meta/_journal.json'), JSON.stringify({ ...journal, entries }));
    for (const entry of entries) {
      await copyFile(join(MIGRATIONS_FOLDER, `${entry.tag}.sql`), join(folder, `${entry.tag}.sql`));
    }
    return folder;
  };
  await runMigrations(testDb.ownerUrl, await folderOf('before-0170', first));

  org = await createTenantWithEntity(pool);
  ({ userId } = await createStaffUser(pool, { ...org }));
  const party = await createParty(pool, { tenantId: org.tenantId, kind: 'customer' });
  customerId = party.partyId;
  await inTx((client) =>
    client.query(
      `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
       VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
      [customerId, org.tenantId, `CUS-${customerId.slice(0, 8)}`, ADDRESS],
    ),
  );

  deals.latest = await deal(true);
  deals.legacy = await deal(true);
  deals.plain = await deal(true);
  deals.quiet = await deal(false);
  // Overridden twice: the later event is the override that stands.
  await overrideEvent(deals.latest, { reason: 'first', orderValue: '5000.00', currency: 'NPR' });
  await overrideEvent(deals.latest, { reason: 'second', orderValue: '9000.00', currency: 'NPR' });
  // Given before the order was counted: no value in the event.
  await overrideEvent(deals.legacy, { reason: 'old', creditLimit: '100000.00', exposure: '1.00' });
  // A value that is not an NPR amount of two decimals is not trusted.
  await overrideEvent(deals.plain, { reason: 'odd', orderValue: 'a lot' });
  // Read before 0170 exists, so the column is not named.
  const { rows: before } = await pool.query<{ version: number }>(
    'SELECT version FROM app.opportunities WHERE id = $1',
    [deals.quiet],
  );
  quietVersionBefore = before[0]!.version;

  await runMigrations(testDb.ownerUrl, await folderOf('through-0171', first + 2));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0171 fills the order value of overrides given earlier', () => {
  it("takes the value of the deal's latest override event", async () => {
    expect((await stored(deals.latest)).value).toBe('9000.00');
  });

  it('leaves an override whose event has no usable value empty, so it covers nothing', async () => {
    expect((await stored(deals.legacy)).value).toBeNull();
    expect((await stored(deals.plain)).value).toBeNull();
  });

  it('leaves a deal without an override alone and moves no deal version', async () => {
    expect(await stored(deals.quiet)).toEqual({ value: null, version: quietVersionBefore });
    expect((await stored(deals.latest)).version).toBe(1);
  });

  it('audits the backfill as the migration', async () => {
    const { rows } = await pool.query<{ n: string }>(
      `SELECT count(*) AS n FROM audit.audit_events
        WHERE actor_id = 'system:migration-0171' AND entity_type = 'opportunities' AND entity_id = $1`,
      [deals.latest],
    );
    expect(Number(rows[0]!.n)).toBeGreaterThan(0);
  });
});

describe('0170 keeps the value beside an override', () => {
  it('refuses a value on a deal with no override, and a negative one', async () => {
    await expect(
      inTx((client) =>
        client.query(
          `UPDATE app.opportunities SET credit_override_order_value = '1.00' WHERE id = $1`,
          [deals.quiet],
        ),
      ),
    ).rejects.toThrow(/opportunities_credit_override_value_check/);
    await expect(
      inTx((client) =>
        client.query(
          `UPDATE app.opportunities SET credit_override_order_value = '-1.00' WHERE id = $1`,
          [deals.latest],
        ),
      ),
    ).rejects.toThrow(/opportunities_credit_override_value_check/);
  });
});
