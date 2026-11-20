// Integration test for AuditService: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.service.test.ts
//
// The service is a thin caller of three SQL functions, so only a real database shows whether the casts, the
// scope filter and the value conversions (bigint, bytea, timestamptz) hold. The container starts with just a
// superuser, so beforeAll creates the roles and default privileges that infra/postgres/init-dbs.sh creates in
// the real stack (same as numbering.service.test.ts), migrates as bos_owner and then works as bos_app.
import { randomUUID } from 'node:crypto';

import { AuditEventDtoSchema } from '@bos/contracts';
import { createStaffUser, createTenantWithEntity, organizations, runMigrations } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { type Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { AuditService } from './audit.service';

const OWNER_PW = 'owner-test-pw';
const APP_PW = 'app-test-pw';

let container: StartedPostgreSqlContainer;
let appPool: Pool;
let db: Db;
let scope: TxScope;
let service: AuditService;

function urlFor(user: string, password: string, database: string): string {
  const url = new URL(container.getConnectionUri());
  url.username = user;
  url.password = password;
  url.pathname = `/${database}`;
  return url.toString();
}

/** Seeds a tenant with its default legal entity (ADR 0027) through the shared fixture. */
async function seedTenant(): Promise<TxScope> {
  const { tenantId, organizationId } = await createTenantWithEntity(appPool);
  return { tenantId, organizationId };
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
  service = new AuditService(db);
  scope = await seedTenant();
}, 120_000);

afterAll(async () => {
  await appPool?.end();
  await container?.stop();
});

describe('AuditService.record', () => {
  it('writes a row inside withTx, with the actor and correlation id of the transaction', async () => {
    const actor = { ...systemActor('test', 'corr-record-1'), ip: '10.1.2.3', userAgent: 'vitest' };
    await withTx(db, scope, actor, (tx) =>
      service.record(tx, {
        action: 'memo.submitted',
        entityType: 'memo',
        entityId: 'memo-1',
        before: { status: 'draft' },
        after: { status: 'submitted' },
        meta: { reason: 'test' },
      }),
    );

    const [event, ...rest] = await service.list(scope, {
      entityType: 'memo',
      entityId: 'memo-1',
      limit: 10,
    });
    expect(rest).toEqual([]);
    expect(event).toMatchObject({
      tenantId: scope.tenantId,
      organizationId: scope.organizationId,
      action: 'memo.submitted',
      actorKind: 'system',
      actorId: 'system:test',
      correlationId: 'corr-record-1',
      ip: '10.1.2.3',
      userAgent: 'vitest',
      before: { status: 'draft' },
      after: { status: 'submitted' },
      meta: { reason: 'test' },
    });
    // The API contract holds for real producer output: string id, hex hashes, ISO time.
    expect(AuditEventDtoSchema.parse(event)).toEqual(event);
    expect(event?.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('keeps before, after and meta null when they are left out', async () => {
    await withTx(db, scope, systemActor('test'), (tx) =>
      service.record(tx, { action: 'memo.viewed', entityType: 'memo', entityId: 'memo-nulls' }),
    );
    const [event] = await service.list(scope, { entityId: 'memo-nulls', limit: 10 });
    expect(event?.before).toBeNull();
    expect(event?.after).toBeNull();
    expect(event?.meta).toBeNull();
  });

  it('refuses a transaction that was not opened with withTx', async () => {
    const bare = db.transaction((tx) =>
      service.record(tx, { action: 'bare', entityType: 'memo', entityId: 'memo-bare' }),
    );
    // Drizzle wraps the driver error ("Failed query: ..."); the database's own message is on `cause`.
    await expect(bare).rejects.toSatisfy((e: Error) =>
      String((e.cause as Error | undefined)?.message ?? e.message).includes('inside withTx()'),
    );
  });

  it('does not keep the event when the surrounding transaction rolls back', async () => {
    const failed = withTx(db, scope, systemActor('test'), async (tx) => {
      await service.record(tx, {
        action: 'memo.lost',
        entityType: 'memo',
        entityId: 'memo-rolled-back',
      });
      throw new Error('business step failed');
    });
    await expect(failed).rejects.toThrow('business step failed');
    expect(await service.list(scope, { entityId: 'memo-rolled-back', limit: 10 })).toEqual([]);
  });
});

describe('AuditService.list', () => {
  it('filters by entity type and id, and keeps tenants apart', async () => {
    const other = await seedTenant();
    await withTx(db, scope, systemActor('test'), async (tx) => {
      await service.record(tx, { action: 'a.one', entityType: 'doc', entityId: 'filter-1' });
      await service.record(tx, { action: 'a.two', entityType: 'doc', entityId: 'filter-2' });
      await service.record(tx, { action: 'a.three', entityType: 'note', entityId: 'filter-1' });
    });
    await withTx(db, other, systemActor('test'), (tx) =>
      service.record(tx, { action: 'b.one', entityType: 'doc', entityId: 'filter-1' }),
    );

    const docOne = await service.list(scope, {
      entityType: 'doc',
      entityId: 'filter-1',
      limit: 50,
    });
    expect(docOne.map((e) => e.action)).toEqual(['a.one']);

    const sameId = await service.list(scope, { entityId: 'filter-1', limit: 50 });
    expect(sameId.map((e) => e.action)).toEqual(['a.one', 'a.three']);

    const theirs = await service.list(other, { entityId: 'filter-1', limit: 50 });
    expect(theirs.map((e) => e.action)).toEqual(['b.one']);
  });

  it('pages forward by id and honours from/to', async () => {
    await withTx(db, scope, systemActor('test'), async (tx) => {
      for (let i = 1; i <= 5; i += 1) {
        await service.record(tx, { action: `page.${i}`, entityType: 'paged', entityId: 'p-1' });
      }
    });
    const first = await service.list(scope, { entityType: 'paged', limit: 2 });
    expect(first.map((e) => e.action)).toEqual(['page.1', 'page.2']);
    // Ids are bigints sent as strings; the cursor goes back the same way.
    const second = await service.list(scope, {
      entityType: 'paged',
      afterId: first[1]?.id,
      limit: 10,
    });
    expect(second.map((e) => e.action)).toEqual(['page.3', 'page.4', 'page.5']);

    const future = new Date(Date.now() + 3_600_000);
    expect(await service.list(scope, { entityType: 'paged', from: future, limit: 10 })).toEqual([]);
    expect(await service.list(scope, { entityType: 'paged', to: future, limit: 10 })).toHaveLength(
      5,
    );
  });
});

describe('AuditService.list order=desc', () => {
  /** Appends `count` events of `entityType`, numbered from `start`, in one transaction. */
  async function append(at: TxScope, entityType: string, start: number, count: number) {
    await withTx(db, at, systemActor('test'), async (tx) => {
      for (let n = start; n < start + count; n += 1) {
        await service.record(tx, { action: 'order.step', entityType, entityId: `step-${n}` });
      }
    });
  }

  it('returns the newest events of a type, newest first, and keeps the default order oldest first', async () => {
    const other = await seedTenant();
    // 60 events of one type, then later ones of the same type in another tenant and of another type here.
    await append(scope, 'order_desc_60', 1, 60);
    await append(other, 'order_desc_60', 61, 5);
    await append(scope, 'order_desc_other', 1, 3);

    const newest = await service.list(scope, {
      entityType: 'order_desc_60',
      limit: 50,
      order: 'desc',
    });
    expect(newest.map((e) => e.entityId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `step-${60 - i}`),
    );
    expect(newest.every((e) => e.tenantId === scope.tenantId)).toBe(true);

    // Left out, the order is unchanged: the oldest 50, oldest first.
    const oldest = await service.list(scope, { entityType: 'order_desc_60', limit: 50 });
    expect(oldest.map((e) => e.entityId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `step-${i + 1}`),
    );
  });

  it('finds the newest events past more than one 500-row page', async () => {
    await append(scope, 'order_desc_many', 1, 300);
    await append(scope, 'order_desc_many', 301, 300);

    const newest = await service.list(scope, {
      entityType: 'order_desc_many',
      limit: 50,
      order: 'desc',
    });
    expect(newest.map((e) => e.entityId)).toEqual(
      Array.from({ length: 50 }, (_, i) => `step-${600 - i}`),
    );
  }, 60_000);
});

describe('AuditService.list canonical text', () => {
  it("returns the jsonb columns exactly as Postgres's ::text prints them", async () => {
    // Written as raw jsonb text so the number keeps its trailing zero; JSON.stringify would drop it.
    const raw = '{"z": 1, "a": 1.50, "m": {"b": 1, "a": 2}}';
    await withTx(db, scope, systemActor('test'), (tx) =>
      tx.execute(
        sql`SELECT audit.record('canon.checked', 'canon', 'canon-1', NULL, ${raw}::jsonb, NULL)`,
      ),
    );
    const expected = (await appPool.query<{ t: string }>('SELECT $1::jsonb::text AS t', [raw]))
      .rows[0]?.t;
    // Guard against a vacuous test: Postgres reorders the keys and keeps 1.50.
    expect(expected).toBe('{"a": 1.50, "m": {"a": 2, "b": 1}, "z": 1}');

    const [event] = await service.list(scope, { entityId: 'canon-1', limit: 10 });
    expect(event?.canonical).toEqual({ before: null, after: expected, meta: null });
    // The parsed field is what node-postgres re-serialised, so it cannot be used to recompute the hash.
    expect(JSON.stringify(event?.after)).not.toBe(event?.canonical.after);
    expect(AuditEventDtoSchema.parse(event)).toEqual(event);
  });
});

describe('AuditService.verifyChain', () => {
  it('is ok for the current month and counts the rows', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const result = await service.verifyChain(scope.tenantId, month);
    expect(result).toMatchObject({ tenantId: scope.tenantId, month, ok: true, firstBadSeq: null });
    // No reason for an intact chain, whether or not verify_chain has the column yet.
    expect(result.reason ?? null).toBeNull();
    expect(result.rows).toBeGreaterThan(0);
    expect(typeof result.rows).toBe('number');
  });

  it('is ok with zero rows for a month with no events', async () => {
    await expect(service.verifyChain(scope.tenantId, '2001-01')).resolves.toEqual({
      tenantId: scope.tenantId,
      month: '2001-01',
      ok: true,
      rows: 0,
      firstBadSeq: null,
      reason: null,
    });
  });
});

describe('row-change events', () => {
  it('shows a write to app.organizations as organizations.insert', async () => {
    const organizationId = randomUUID();
    const orgScope = { tenantId: scope.tenantId, organizationId };
    await withTx(db, orgScope, systemActor('test'), (tx) =>
      tx.insert(organizations).values({
        id: organizationId,
        tenantId: scope.tenantId,
        organizationId,
        code: `E${organizationId.slice(0, 8)}`,
        name: 'Second org',
        legalName: 'Second org Pvt. Ltd.',
      }),
    );

    const events = await service.list(orgScope, {
      entityType: 'organizations',
      entityId: organizationId,
      limit: 10,
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'organizations.insert',
      actorId: 'system:test',
      before: null,
      after: { id: organizationId, name: 'Second org' },
    });
  });
});

describe('AuditService.list actor names', () => {
  // Real producer, real consumer: the event is written by audit.record() under a real app.users id (as an
  // approval decision is), and read back through list() exactly as GET /v1/audit serves it.
  it('names a seeded person, and leaves unknown, other-tenant and non-user actors as null', async () => {
    const mine = await createTenantWithEntity(appPool);
    const theirs = await createTenantWithEntity(appPool);
    const mineScope: TxScope = { tenantId: mine.tenantId, organizationId: mine.organizationId };
    const { userId } = await createStaffUser(appPool, { ...mine, roleKeys: ['accountant'] });
    const { userId: strangerId } = await createStaffUser(appPool, { ...theirs, roleKeys: [] });
    const unknownId = randomUUID();
    const seeded = await appPool.query<{ display_name: string }>(
      'SELECT display_name FROM app.users WHERE id = $1',
      [userId],
    );
    const seededName = seeded.rows[0]?.display_name;
    expect(seededName).toBeTruthy();

    const as = (kind: 'user' | 'system', id: string) => ({
      kind,
      id,
      correlationId: `corr-${id}`,
    });
    const record = (actor: ReturnType<typeof as>, action: string) =>
      withTx(db, mineScope, actor, (tx) =>
        service.record(tx, { action, entityType: 'named', entityId: 'n-1' }),
      );
    await record(as('user', userId), 'named.by_person');
    await record(as('user', strangerId), 'named.by_other_tenant_person');
    await record(as('user', unknownId), 'named.by_unknown_person');
    await record(as('system', 'system:seal'), 'named.by_system');

    const events = await service.list(mineScope, { entityType: 'named', limit: 10 });
    const nameOf = (action: string) => events.find((e) => e.action === action)?.actorDisplayName;
    expect(nameOf('named.by_person')).toBe(seededName);
    expect(nameOf('named.by_other_tenant_person')).toBeNull();
    expect(nameOf('named.by_unknown_person')).toBeNull();
    expect(nameOf('named.by_system')).toBeNull();
    // Stored rows and the hash chain are unchanged by the lookup: the actor ids are as written.
    expect(events.map((e) => e.actorId)).toEqual([userId, strangerId, unknownId, 'system:seal']);
    for (const e of events) expect(AuditEventDtoSchema.parse(e)).toEqual(e);
  });
});
