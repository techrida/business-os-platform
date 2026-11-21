// Integration test for NumberingService: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/numbering.service.test.ts
//
// Only a real database can show the two promises that matter: concurrent callers never share a number, and a
// rolled-back transaction gives its number back. The container starts with just a superuser, so beforeAll
// creates the roles and default privileges that infra/postgres/init-dbs.sh creates in the real stack (same as
// packages/db/src/db.test.ts), migrates as bos_owner and then works as bos_app.
import { createTenantWithEntity, settings } from '@bos/db';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { NumberingService } from './numbering.service';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

// 2025-07-16T18:15Z is 2025-07-17 00:00 in Kathmandu: Shrawan 1, 2082 BS, the first day of fiscal year 2082/83.
const FIRST_DAY_OF_FY = new Date('2025-07-16T18:15:00Z');

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let scope: TxScope;
const numbering = new NumberingService();

/** One number in its own committed transaction, the way a request would take it. */
function take(key: string, at: Date = FIRST_DAY_OF_FY): Promise<string> {
  return withTx(db, scope, systemActor('test'), (tx) => numbering.next(tx, key, at));
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  // Ten connections, so the 50-way test queues on the pool as well as on the row lock.
  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  db = drizzle({ client: appPool });

  // Seed a tenant with its default legal entity (ADR 0027) through the shared fixture.
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  scope = { tenantId, organizationId };
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('NumberingService.next', () => {
  it('gives 50 concurrent callers 50 distinct, consecutive numbers', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => take('MEMO')));

    expect(new Set(results).size).toBe(50);
    const counters = results.map((r) => Number(r.split('-').at(-1))).sort((a, b) => a - b);
    expect(counters).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(results).toContain('MEMO-2082/83-00001');
    expect(results).toContain('MEMO-2082/83-00050');
    // 50 real transactions against Testcontainers Postgres: give a loaded machine room.
  }, 30_000);

  it('leaves no gap when a transaction rolls back: the same number is handed out again', async () => {
    expect(await take('ROLL')).toBe('ROLL-2082/83-00001');

    const failed = withTx(db, scope, systemActor('test'), async (tx) => {
      expect(await numbering.next(tx, 'ROLL', FIRST_DAY_OF_FY)).toBe('ROLL-2082/83-00002');
      throw new Error('business step failed');
    });
    await expect(failed).rejects.toThrow('business step failed');

    expect(await take('ROLL')).toBe('ROLL-2082/83-00002');
  });

  it('leaves no gap when the very first number of a series is rolled back', async () => {
    const failed = withTx(db, scope, systemActor('test'), async (tx) => {
      await numbering.next(tx, 'FIRST', FIRST_DAY_OF_FY);
      throw new Error('boom');
    });
    await expect(failed).rejects.toThrow('boom');

    expect(await take('FIRST')).toBe('FIRST-2082/83-00001');
  });

  it('starts a new series on Shrawan 1 (Kathmandu midnight), not before', async () => {
    // One minute earlier it is still 23:59 on the last day of Asar 2082, so fiscal year 2081/82.
    expect(await take('FY', new Date('2025-07-16T18:14:00Z'))).toBe('FY-2081/82-00001');
    expect(await take('FY', FIRST_DAY_OF_FY)).toBe('FY-2082/83-00001');
    expect(await take('FY', new Date('2025-07-16T18:14:00Z'))).toBe('FY-2081/82-00002');
  });

  it('refuses a transaction that was not opened with withTx', async () => {
    await expect(
      db.transaction((tx) => numbering.next(tx, 'BARE', FIRST_DAY_OF_FY)),
    ).rejects.toThrow(/withTx/);
  });
});

describe('NumberingService.issue', () => {
  it('returns the counter, the formatted number and the fiscal year of the series', async () => {
    const issue = (): ReturnType<NumberingService['issue']> =>
      withTx(db, scope, systemActor('test'), (tx) => numbering.issue(tx, 'ISSUE', FIRST_DAY_OF_FY));

    const first = await issue();
    const second = await issue();

    expect(first).toEqual({ number: 'ISSUE-2082/83-00001', seq: 1, fiscalYear: '2082/83' });
    expect(second.seq).toBe(first.seq + 1);
    expect(second.number).toBe('ISSUE-2082/83-00002');
    expect(second.fiscalYear).toBe(first.fiscalYear);
    expect(typeof second.seq).toBe('number');
  });

  it('reports the fiscal year of the date it was asked for', async () => {
    const before = await withTx(db, scope, systemActor('test'), (tx) =>
      numbering.issue(tx, 'ISSUEFY', new Date('2025-07-16T18:14:00Z')),
    );
    expect(before.fiscalYear).toBe('2081/82');
    expect(before.number).toBe('ISSUEFY-2081/82-00001');
  });
});

describe('app.settings', () => {
  it('is append-only: UPDATE and DELETE raise, a new version inserts', async () => {
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.insert(settings).values({
        ...scope,
        key: 'tax.vat_rate',
        version: 1,
        value: { rate: '0.13' },
      });
    });

    await expect(
      appPool.query(`UPDATE app.settings SET value = '{"rate":"0.5"}' WHERE key = 'tax.vat_rate'`),
    ).rejects.toThrow(/settings are append-only: insert a new version/);
    await expect(
      appPool.query(`DELETE FROM app.settings WHERE key = 'tax.vat_rate'`),
    ).rejects.toThrow(/settings are append-only/);

    await withTx(db, scope, systemActor('test'), async (tx) => {
      await tx.insert(settings).values({
        ...scope,
        key: 'tax.vat_rate',
        version: 2,
        value: { rate: '0.15' },
      });
    });
    const { rows } = await appPool.query<{ n: string }>(
      `SELECT count(*) AS n FROM app.settings WHERE key = 'tax.vat_rate'`,
    );
    expect(rows[0]?.n).toBe('2');
  });
});
