// Integration test for NumberingService: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/settings/numbering.service.test.ts
//
// Only a real database can show the two promises that matter: concurrent callers never share a number, and a
// rolled-back transaction gives its number back. The container starts with just a superuser, so beforeAll
// creates the roles and default privileges that infra/postgres/init-dbs.sh creates in the real stack (same as
// packages/db/src/db.test.ts), migrates as bos_owner and then works as bos_app.
import { randomUUID } from 'node:crypto';

import { organizations, runMigrations, settings, tenants } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { NumberingService } from './numbering.service';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

// 2025-07-16T18:15Z is 2025-07-17 00:00 in Kathmandu: Shrawan 1, 2082 BS, the first day of fiscal year 2082/83.
const FIRST_DAY_OF_FY = new Date('2025-07-16T18:15:00Z');

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let scope: TxScope;
const numbering = new NumberingService();

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** One number in its own committed transaction, the way a request would take it. */
function take(key: string, at: Date = FIRST_DAY_OF_FY): Promise<string> {
  return withTx(db, scope, systemActor('test'), (tx) => numbering.next(tx, key, at));
}

beforeAll(async () => {
  container = await new PostgreSqlContainer('postgres:16-alpine').start();

  const admin = new Pool({ connectionString: container.getConnectionUri(), max: 1 });
  await admin.query(`CREATE ROLE bos_owner LOGIN PASSWORD '${OWNER_PW}'`);
  await admin.query(`CREATE ROLE bos_app LOGIN PASSWORD '${APP_PW}'`);
  await admin.query('CREATE DATABASE bos OWNER bos_owner');
  await admin.query('REVOKE ALL ON DATABASE bos FROM PUBLIC');
  await admin.query('GRANT CONNECT ON DATABASE bos TO bos_app');
  await admin.end();

  const bosAdmin = new Pool({ connectionString: urlFor('test', 'test', 'bos'), max: 1 });
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT USAGE ON SCHEMAS TO bos_app',
  );
  await bosAdmin.query(
    'ALTER DEFAULT PRIVILEGES FOR ROLE bos_owner GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO bos_app',
  );
  await bosAdmin.end();

  await runMigrations(urlFor('bos_owner', OWNER_PW, 'bos'));

  // Ten connections, so the 50-way test queues on the pool as well as on the row lock.
  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 10 });
  db = drizzle({ client: appPool });

  // Seed a tenant and an organization through withTx, like every other write to an app table.
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  scope = { tenantId, organizationId };
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(tenants).values({ id: tenantId });
    await tx.insert(organizations).values({
      id: organizationId,
      tenantId,
      organizationId,
      kind: 'staff',
      name: 'Techrida',
      zitadelOrgId: `zitadel-${organizationId}`,
    });
  });
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('NumberingService.next', () => {
  it('gives 50 concurrent callers 50 distinct, consecutive numbers', async () => {
    const results = await Promise.all(Array.from({ length: 50 }, () => take('MEMO')));

    expect(new Set(results).size).toBe(50);
    const counters = results.map((r) => Number(r.split('-').at(-1))).sort((a, b) => a - b);
    expect(counters).toEqual(Array.from({ length: 50 }, (_, i) => i + 1));
    expect(results).toContain('MEMO-2082/83-00001');
    expect(results).toContain('MEMO-2082/83-00050');
  });

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
