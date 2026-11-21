// Integration test for withIdempotency and updateVersioned: a real postgres:16-alpine started by Testcontainers.
// Run with: pnpm --filter @bos/api exec vitest run src/platform/db/idempotency.integration.test.ts
//
// The race between two first calls, the claim that disappears on rollback and the unique key per actor only
// show up against a real database. Setup is the same as settings.integration.test.ts: create the roles,
// migrate as bos_owner, then work as bos_app.
import { randomUUID } from 'node:crypto';

import { appSchema, createTenantWithEntity, idempotencyKeys } from '@bos/db';
import { ConflictException, UnprocessableEntityException } from '@nestjs/common';
import { eq } from 'drizzle-orm';
import { integer, text, uuid } from 'drizzle-orm/pg-core';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from './db.module';
import { updateVersioned, withIdempotency } from './idempotency';
import { type Actor, type TxScope, systemActor, withTx } from './tx';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

let testDb: TestDatabase;
let ownerPool: Pool;
let appPool: Pool;
let db: Db;

/** A throwaway versioned table: updateVersioned works on any table with id and version columns. */
const probes = appSchema.table('idem_probes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tenantId: uuid('tenant_id').notNull(),
  organizationId: uuid('organization_id').notNull(),
  name: text('name').notNull(),
  version: integer('version').notNull().default(1),
});

/** Each test uses its own tenant, so no test sees another's rows. */
async function newScope(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
}

function userActor(id = randomUUID()): Actor {
  return { kind: 'user', id, correlationId: `corr-${id}` };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  ownerPool = new Pool({ connectionString: testDb.ownerUrl, max: 1 });
  await ownerPool.query(
    `CREATE TABLE app.idem_probes (
       id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
       tenant_id uuid NOT NULL,
       organization_id uuid NOT NULL,
       name text NOT NULL,
       version integer NOT NULL DEFAULT 1)`,
  );

  appPool = new Pool({ connectionString: testDb.appUrl, max: 10 });
  // An idle client that Postgres drops during teardown (57P01) emits 'error' on the pool; unhandled,
  // vitest counts it as a failure. The app's pool ignores it the same way.
  appPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
}, 120_000);

afterAll(async () => {
  await ownerPool?.end();
  await appPool?.end();
  await testDb?.drop();
});

describe('withIdempotency', () => {
  it('runs fn once and replays the stored answer for the same key and body', async () => {
    const scope = await newScope();
    const actor = userActor();
    let calls = 0;
    const run = (body: unknown) =>
      withTx(db, scope, actor, (tx) =>
        withIdempotency(tx, { command: 'memo.create', key: 'k-1', body }, async () => {
          calls += 1;
          await Promise.resolve();
          return { status: 201, response: { id: 'memo-1', n: calls } };
        }),
      );

    const first = await run({ title: 'a', amount: 5 });
    // Same body with its keys in another order hashes the same (canonical JSON).
    const second = await run({ amount: 5, title: 'a' });

    expect(calls).toBe(1);
    expect(first).toEqual({ status: 201, response: { id: 'memo-1', n: 1 }, replayed: false });
    expect(second).toEqual({ status: 201, response: { id: 'memo-1', n: 1 }, replayed: true });
  });

  it('refuses the same key with a different body with 422 and does not run fn', async () => {
    const scope = await newScope();
    const actor = userActor();
    let calls = 0;
    const run = (body: unknown) =>
      withTx(db, scope, actor, (tx) =>
        withIdempotency(tx, { command: 'memo.create', key: 'k-2', body }, () => {
          calls += 1;
          return Promise.resolve({ status: 200, response: { ok: true } });
        }),
      );

    await run({ title: 'a' });
    const error: unknown = await run({ title: 'b' }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(UnprocessableEntityException);
    expect((error as UnprocessableEntityException).getStatus()).toBe(422);
    expect(calls).toBe(1);
  });

  it('scopes a key to its actor, command and tenant', async () => {
    const scope = await newScope();
    const other = await newScope();
    let calls = 0;
    const run = (s: TxScope, actor: Actor, command: string) =>
      withTx(db, s, actor, (tx) =>
        withIdempotency(tx, { command, key: 'shared', body: { x: 1 } }, () => {
          calls += 1;
          return Promise.resolve({ status: 200, response: { calls } });
        }),
      );
    const alice = userActor();

    await run(scope, alice, 'a');
    await run(scope, userActor(), 'a'); // another actor
    await run(scope, alice, 'b'); // another command
    await run(other, alice, 'a'); // another tenant

    expect(calls).toBe(4);
  });

  it('runs fn once when two first calls arrive at the same time', async () => {
    const scope = await newScope();
    const actor = userActor();
    let calls = 0;
    const run = () =>
      withTx(db, scope, actor, (tx) =>
        withIdempotency(tx, { command: 'memo.create', key: 'race', body: { n: 1 } }, async () => {
          calls += 1;
          // Long enough for the second call to reach its INSERT while the first still holds the claim.
          await sleep(300);
          return { status: 201, response: { id: 'memo-race' } };
        }),
      );

    const [a, b] = await Promise.all([run(), run()]);

    expect(calls).toBe(1);
    expect(a.response).toEqual({ id: 'memo-race' });
    expect(b.response).toEqual({ id: 'memo-race' });
    expect([a.replayed, b.replayed].sort()).toEqual([false, true]);
  });

  it('frees the key when the first call rolls back, so a retry runs fn', async () => {
    const scope = await newScope();
    const actor = userActor();
    let calls = 0;
    const run = (fail: boolean) =>
      withTx(db, scope, actor, (tx) =>
        withIdempotency(tx, { command: 'memo.create', key: 'rb', body: {} }, () => {
          calls += 1;
          if (fail) throw new Error('boom');
          return Promise.resolve({ status: 200, response: { ok: true } });
        }),
      );

    await expect(run(true)).rejects.toThrow('boom');
    const retry = await run(false);

    expect(calls).toBe(2);
    expect(retry.replayed).toBe(false);
    const rows = await db
      .select({ status: idempotencyKeys.status })
      .from(idempotencyKeys)
      .where(eq(idempotencyKeys.tenantId, scope.tenantId));
    expect(rows).toEqual([{ status: 200 }]);
  });
});

describe('updateVersioned', () => {
  async function insertProbe(scope: TxScope): Promise<string> {
    const [row] = await withTx(db, scope, systemActor('test'), (tx) =>
      tx
        .insert(probes)
        .values({ tenantId: scope.tenantId, organizationId: scope.organizationId, name: 'one' })
        .returning({ id: probes.id }),
    );
    if (row === undefined) throw new Error('probe insert returned no row');
    return row.id;
  }

  it('updates on the expected version and bumps it', async () => {
    const scope = await newScope();
    const id = await insertProbe(scope);
    const actor = userActor();

    const updated = await withTx(db, scope, actor, (tx) =>
      updateVersioned(tx, probes, id, 1, { name: 'two' }),
    );
    expect(updated).toMatchObject({ id, name: 'two', version: 2 });

    const again = await withTx(db, scope, actor, (tx) =>
      updateVersioned(tx, probes, id, 2, { name: 'three' }),
    );
    expect(again).toMatchObject({ name: 'three', version: 3 });
  });

  it('answers 409 for a stale version and leaves the row alone', async () => {
    const scope = await newScope();
    const id = await insertProbe(scope);
    const actor = userActor();
    await withTx(db, scope, actor, (tx) => updateVersioned(tx, probes, id, 1, { name: 'two' }));

    const error: unknown = await withTx(db, scope, actor, (tx) =>
      updateVersioned(tx, probes, id, 1, { name: 'stale' }),
    ).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getStatus()).toBe(409);
    const [row] = await db.select().from(probes).where(eq(probes.id, id));
    expect(row).toMatchObject({ name: 'two', version: 2 });
  });

  it('lets only one of two writers holding the same version win', async () => {
    const scope = await newScope();
    const id = await insertProbe(scope);
    const write = (name: string) =>
      withTx(db, scope, userActor(), (tx) => updateVersioned(tx, probes, id, 1, { name })).then(
        () => 'ok',
        (e: unknown) => (e instanceof ConflictException ? 'conflict' : 'other'),
      );

    const results = await Promise.all([write('a'), write('b')]);

    expect(results.sort()).toEqual(['conflict', 'ok']);
  });

  it('does not touch a row of another tenant (409, as if the version were stale)', async () => {
    const scope = await newScope();
    const other = await newScope();
    const id = await insertProbe(scope);

    await expect(
      withTx(db, other, userActor(), (tx) => updateVersioned(tx, probes, id, 1, { name: 'x' })),
    ).rejects.toBeInstanceOf(ConflictException);
    const [row] = await db.select().from(probes).where(eq(probes.id, id));
    expect(row).toMatchObject({ name: 'one', version: 1 });
  });

  it('refuses a set that names id or version', async () => {
    const scope = await newScope();
    const id = await insertProbe(scope);

    await expect(
      withTx(db, scope, userActor(), (tx) => updateVersioned(tx, probes, id, 1, { version: 99 })),
    ).rejects.toThrow(/version/);
  });
});
