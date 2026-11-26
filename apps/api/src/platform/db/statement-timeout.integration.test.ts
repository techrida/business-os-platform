// Integration test for the statement limit and the tenant-lock wait metric of withTx, against a real
// postgres:16-alpine started by Testcontainers.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/db/statement-timeout.integration.test.ts
import { randomUUID } from 'node:crypto';

import { createTenantWithEntity } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { MetricsService } from '../obs/metrics.service';
import { dbBusyKindOf, pgErrorCode } from './busy';
import type { Db } from './db.module';
import { type Actor, type TxScope, withTx } from './tx';
import { configureTx, setTxObserver } from './tx-settings';

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function newScope(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

function actor(): Actor {
  const id = randomUUID();
  return { kind: 'user', id, correlationId: `corr-${id}` };
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
}, 120_000);

afterEach(() => {
  configureTx({});
  setTxObserver(undefined);
});

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

describe('withTx statement limit', () => {
  it('cancels a statement that outlasts it with 57014, which the API answers as a retryable 503', async () => {
    configureTx({ statementTimeoutMs: 300 });
    const scope = await newScope();
    const started = performance.now();
    const failure = await withTx(db, scope, actor(), (tx) => tx.execute(sql`select pg_sleep(3)`)).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(pgErrorCode(failure)).toBe('57014');
    expect(dbBusyKindOf(failure)).toBe('statement_timeout');
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  it('lets a transaction that asks for a longer limit run its slow statement', async () => {
    configureTx({ statementTimeoutMs: 300 });
    const scope = await newScope();
    await expect(
      withTx(db, scope, actor(), (tx) => tx.execute(sql`select pg_sleep(0.6)`), {
        statementTimeoutMs: 5_000,
      }),
    ).resolves.toBeDefined();
  });

  it('does not leak the limit to the next transaction on the same connection', async () => {
    const solo = new Pool({ connectionString: testDb.appUrl, max: 1 });
    solo.on('error', () => undefined);
    try {
      const soloDb = drizzle({ client: solo });
      const scope = await newScope();
      configureTx({ statementTimeoutMs: 123 });
      await withTx(soloDb, scope, actor(), () => Promise.resolve());
      const shown = await solo.query<{ statement_timeout: string }>('show statement_timeout');
      expect(shown.rows[0]?.statement_timeout).not.toBe('123ms');
    } finally {
      await solo.end();
    }
  });
});

describe('db_tenant_lock_wait_seconds', () => {
  it('records the time a second transaction waited for its tenant lock behind the first', async () => {
    const metrics = new MetricsService();
    setTxObserver(metrics);
    const scope = await newScope();
    let held!: () => void;
    const holding = new Promise<void>((resolve) => {
      held = resolve;
    });
    const first = withTx(db, scope, actor(), async () => {
      held();
      await sleep(400);
    });
    await holding;
    const before = performance.now();
    await withTx(db, scope, actor(), () => Promise.resolve());
    const waited = (performance.now() - before) / 1000;
    await first;

    const text = await metrics.render();
    const sum = /^db_tenant_lock_wait_seconds_sum ([0-9.e+-]+)$/m.exec(text)?.[1];
    expect(text).toMatch(/^db_tenant_lock_wait_seconds_count 2$/m);
    // The first transaction waited about nothing; the second waited behind the 400 ms hold.
    expect(Number(sum)).toBeGreaterThanOrEqual(0.2);
    expect(Number(sum)).toBeLessThanOrEqual(waited + 0.1);
  });
});
