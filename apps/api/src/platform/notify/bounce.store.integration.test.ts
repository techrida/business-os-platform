// Integration test for SqlBounceStore: a real postgres:16-alpine started by Testcontainers (needs Docker). Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/notify/bounce.store.integration.test.ts
// Setup is the same as outbox.claim.integration.test.ts: roles, migrations as bos_owner, work as bos_app.
import { randomUUID } from 'node:crypto';

import { organizations, outbox, tenants } from '@bos/db';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { SqlBounceStore } from './bounce.store';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';

let testDb: TestDatabase;
let appPool: Pool;
let db: Db;
let store: SqlBounceStore;
let scopeA: TxScope;
let scopeB: TxScope;

async function seedTenant(): Promise<TxScope> {
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  const scope = { tenantId, organizationId };
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(tenants).values({ id: tenantId });
    await tx.insert(organizations).values({
      id: organizationId,
      tenantId,
      organizationId,
      code: `E${organizationId.slice(0, 8)}`,
      name: 'Techrida',
      legalName: 'Techrida Pvt. Ltd.',
    });
  });
  return scope;
}

async function seed(
  scope: TxScope,
  row: { to: string; status: 'pending' | 'sent'; providerMessageId?: string },
): Promise<string> {
  const id = randomUUID();
  await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(outbox).values({
      id,
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      kind: 'email',
      template: 'quotation.sent',
      toEmail: row.to,
      subject: 'Subject',
      bodyText: 'Body',
      dedupeKey: randomUUID(),
      status: row.status,
      ...(row.providerMessageId === undefined ? {} : { providerMessageId: row.providerMessageId }),
    });
  });
  return id;
}

async function rowOf(id: string) {
  const [row] = await db.select().from(outbox).where(eq(outbox.id, id));
  if (row === undefined) throw new Error(`no outbox row ${id}`);
  return row;
}

beforeAll(async () => {
  testDb = await createTestDatabase();

  const admin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await admin.end();

  const bosAdmin = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  await bosAdmin.end();

  appPool = new Pool({ connectionString: testDb.appUrl, max: 5 });
  db = drizzle({ client: appPool });
  store = new SqlBounceStore(db);
  scopeA = await seedTenant();
  scopeB = await seedTenant();
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await testDb?.drop();
});

beforeEach(async () => {
  await appPool.query('DELETE FROM app.outbox');
});

describe('SqlBounceStore', () => {
  it('a hard bounce marks the sent row and kills the pending mail for that recipient in that tenant only', async () => {
    const sent = await seed(scopeA, {
      to: 'buyer@customer.test',
      status: 'sent',
      providerMessageId: '<abc@mail.test>',
    });
    const sameAddressPending = await seed(scopeA, { to: 'Buyer@Customer.test', status: 'pending' });
    const otherAddressPending = await seed(scopeA, {
      to: 'other@customer.test',
      status: 'pending',
    });
    const otherTenantPending = await seed(scopeB, { to: 'buyer@customer.test', status: 'pending' });

    // Postal reports the id without angle brackets; the outbox kept them.
    expect(await store.markBounced({ messageId: 'abc@mail.test', kind: 'hard' })).toBe(1);

    expect(await rowOf(sent)).toMatchObject({ status: 'sent', lastError: 'bounced (hard)' });
    expect(await rowOf(sameAddressPending)).toMatchObject({
      status: 'dead',
      lastError: 'recipient bounced',
    });
    expect((await rowOf(otherAddressPending)).status).toBe('pending');
    expect((await rowOf(otherTenantPending)).status).toBe('pending');
  });

  it('a soft bounce only notes the row', async () => {
    const sent = await seed(scopeA, {
      to: 'buyer@customer.test',
      status: 'sent',
      providerMessageId: 'plain-id@mail.test',
    });
    const pending = await seed(scopeA, { to: 'buyer@customer.test', status: 'pending' });

    expect(await store.markBounced({ messageId: 'plain-id@mail.test', kind: 'soft' })).toBe(1);

    expect(await rowOf(sent)).toMatchObject({ status: 'sent', lastError: 'bounced (soft)' });
    expect((await rowOf(pending)).status).toBe('pending');
  });

  it('an unknown message id changes nothing and reports 0', async () => {
    const pending = await seed(scopeA, { to: 'buyer@customer.test', status: 'pending' });
    expect(await store.markBounced({ messageId: 'nobody@mail.test', kind: 'hard' })).toBe(0);
    expect((await rowOf(pending)).status).toBe('pending');
  });
});
