// Integration test for SqlBounceStore: a real postgres:16-alpine started by Testcontainers (needs Docker). Run with:
//   pnpm --filter @bos/api exec vitest run src/platform/notify/bounce.store.integration.test.ts
// Setup is the same as outbox.claim.integration.test.ts: roles, migrations as bos_owner, work as bos_app.
import { randomUUID } from 'node:crypto';

import { organizations, outbox, runMigrations, tenants } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { SqlBounceStore } from './bounce.store';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let store: SqlBounceStore;
let scopeA: TxScope;
let scopeB: TxScope;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

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
      kind: 'staff',
      name: 'Techrida',
      zitadelOrgId: `zitadel-${organizationId}`,
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

  appPool = new Pool({ connectionString: urlFor('bos_app', APP_PW, 'bos'), max: 5 });
  db = drizzle({ client: appPool });
  store = new SqlBounceStore(db);
  scopeA = await seedTenant();
  scopeB = await seedTenant();
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
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
