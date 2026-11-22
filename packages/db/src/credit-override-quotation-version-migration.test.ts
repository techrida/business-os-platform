// Integration test for migration 0183 (R5 FU10): a credit override covers exactly one quotation version.
//   * 0183 adds opportunities.credit_override_quotation_version_id. An override given before it keeps the column
//     null (no backfill), so it covers nothing and its deal needs a new override (fails closed); the deal's
//     version does not move.
//   * The version only ever sits beside an override (opportunities_credit_override_quotation_version_check).
//   * Its FK is composite with the entity: a version of another tenant, or one that does not exist, is refused
//     (opportunities_credit_override_quotation_version_fk).
// Migrates only up to the migration before 0183, seeds, then runs 0183.
// Needs Docker: an unmigrated database of its own on the run's shared postgres:16-alpine. Run with:
//   pnpm --filter @bos/db exec vitest run src/credit-override-quotation-version-migration.test.ts
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

const TAG = '0183_credit_override_quotation_version';
const ADDRESS = JSON.stringify({ line1: 'Durbar Marg 1', city: 'Kathmandu', country: 'NP' });

interface JournalEntry {
  idx: number;
  when: number;
  tag: string;
}

interface Deal {
  opportunityId: string;
  versionId: string;
  versionBefore: number;
}

let testDb: TestDatabase;
let pool: Pool;
let org: TenantWithEntity;
let other: TenantWithEntity;
const folders: string[] = [];
let legacy: Deal;
let quiet: Deal;
let foreign: Deal;

/** Runs fn in one transaction as the audit actor, acting for `on`'s entity; rolls back on a throw. */
async function inTx<T>(on: TenantWithEntity, fn: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT set_config('bos.actor_kind', 'system', true),
              set_config('bos.actor_id', 'credit-override-version-migration-test', true),
              set_config('bos.correlation_id', $1, true),
              set_config('bos.tenant_id', $2, true),
              set_config('bos.organization_id', $3, true)`,
      [randomUUID(), on.tenantId, on.organizationId],
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

/** One statement in `on`'s entity; returns the first row's id when it has RETURNING id. */
async function exec(on: TenantWithEntity, text: string, params: unknown[] = []): Promise<string> {
  return inTx(on, async (c) => {
    const { rows } = await c.query<{ id?: string }>(text, params);
    return rows[0]?.id ?? '';
  });
}

/**
 * A deal of a new customer of `on`'s entity with a quotation and its first version; `overridden` gives the deal an
 * override (reason, user, time, order value) as 0103 and 0170 store one.
 */
async function deal(on: TenantWithEntity, overridden: boolean): Promise<Deal> {
  const { userId } = await createStaffUser(pool, { ...on });
  const { partyId } = await createParty(pool, { tenantId: on.tenantId, kind: 'customer' });
  await exec(
    on,
    `INSERT INTO app.customers (id, tenant_id, number, legal_name, name_norm, address)
     VALUES ($1, $2, $3, 'Acme Pvt. Ltd.', 'acme', $4::jsonb)`,
    [partyId, on.tenantId, `CUS-${partyId.slice(0, 8)}`, ADDRESS],
  );
  const opportunityId = await exec(
    on,
    `INSERT INTO app.opportunities
       (tenant_id, organization_id, number, name, customer_id,
        credit_override_reason, credit_override_by_user_id, credit_override_at, credit_override_order_value)
     VALUES ($1, $2, $3, 'Acme website', $4, $5, $6, $7, $8) RETURNING id`,
    [
      on.tenantId,
      on.organizationId,
      `DEAL-${randomUUID().slice(0, 8)}`,
      partyId,
      overridden ? 'Director approved' : null,
      overridden ? userId : null,
      overridden ? new Date() : null,
      overridden ? '113000.00' : null,
    ],
  );
  const quotationId = await exec(
    on,
    `INSERT INTO app.quotations (tenant_id, organization_id, number, customer_party_id, opportunity_id)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [on.tenantId, on.organizationId, `QT-${randomUUID().slice(0, 8)}`, partyId, opportunityId],
  );
  const versionId = await exec(
    on,
    `INSERT INTO app.quotation_versions
       (tenant_id, organization_id, quotation_id, revision_no, currency, issue_date, valid_until)
     VALUES ($1, $2, $3, 1, 'NPR', '2026-11-09', '2026-12-09') RETURNING id`,
    [on.tenantId, on.organizationId, quotationId],
  );
  const { rows } = await pool.query<{ version: number }>(
    'SELECT version FROM app.opportunities WHERE id = $1',
    [opportunityId],
  );
  return { opportunityId, versionId, versionBefore: rows[0]!.version };
}

async function stored(id: string) {
  const { rows } = await pool.query<{ versionId: string | null; version: number }>(
    `SELECT credit_override_quotation_version_id AS "versionId", version FROM app.opportunities WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

const setVersion = (opportunityId: string, versionId: string) =>
  inTx(org, (client) =>
    client.query(
      `UPDATE app.opportunities SET credit_override_quotation_version_id = $2 WHERE id = $1`,
      [opportunityId, versionId],
    ),
  );

beforeAll(async () => {
  testDb = await createTestDatabase({ migrated: false });
  pool = new Pool({ connectionString: testDb.ownerUrl, max: 2 });

  const journal = JSON.parse(
    await readFile(join(MIGRATIONS_FOLDER, 'meta/_journal.json'), 'utf8'),
  ) as { entries: JournalEntry[] };
  const at = journal.entries.findIndex((entry) => entry.tag === TAG);
  expect(at, `${TAG} is in the journal`).toBeGreaterThan(0);
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
  await runMigrations(testDb.ownerUrl, await folderOf('before-0183', at));

  org = await createTenantWithEntity(pool);
  other = await createTenantWithEntity(pool);
  legacy = await deal(org, true);
  quiet = await deal(org, false);
  foreign = await deal(other, true);

  await runMigrations(testDb.ownerUrl, await folderOf('through-0183', at + 1));
}, 180_000);

afterAll(async () => {
  await pool?.end();
  await testDb?.drop();
  for (const folder of folders) await rm(folder, { recursive: true, force: true });
});

describe('0183 keeps the quotation version an override was given for', () => {
  it('leaves an override given earlier without a version, so it covers nothing, and moves no deal version', async () => {
    expect(await stored(legacy.opportunityId)).toEqual({
      versionId: null,
      version: legacy.versionBefore,
    });
    expect(await stored(quiet.opportunityId)).toEqual({
      versionId: null,
      version: quiet.versionBefore,
    });
  });

  it('accepts a version of the same entity beside an override', async () => {
    await setVersion(legacy.opportunityId, legacy.versionId);
    expect((await stored(legacy.opportunityId)).versionId).toBe(legacy.versionId);
  });

  it('refuses a version on a deal with no override', async () => {
    await expect(setVersion(quiet.opportunityId, quiet.versionId)).rejects.toThrow(
      /opportunities_credit_override_quotation_version_check/,
    );
  });

  it("refuses another tenant's version and one that does not exist", async () => {
    await expect(setVersion(legacy.opportunityId, foreign.versionId)).rejects.toThrow(
      /opportunities_credit_override_quotation_version_fk/,
    );
    await expect(setVersion(legacy.opportunityId, randomUUID())).rejects.toThrow(
      /opportunities_credit_override_quotation_version_fk/,
    );
  });
});
