// Integration test for AuditService: a real postgres:16-alpine started by Testcontainers (needs Docker).
// Run with: pnpm --filter @bos/api exec vitest run src/platform/audit/audit.service.test.ts
//
// The service is a thin caller of three SQL functions, so only a real database shows whether the casts, the
// scope filter and the value conversions (bigint, bytea, timestamptz) hold. The container starts with just a
// superuser, so beforeAll creates the roles and default privileges that infra/postgres/init-dbs.sh creates in
// the real stack (same as numbering.service.test.ts), migrates as bos_owner and then works as bos_app.
import { randomUUID } from 'node:crypto';

import { AuditEventDtoSchema } from '@bos/contracts';
import { organizations, runMigrations, tenants } from '@bos/db';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
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

/** Seeds a tenant with one organization through withTx, like every other write to an app table. */
async function seedTenant(): Promise<TxScope> {
  const tenantId = randomUUID();
  const organizationId = randomUUID();
  const s = { tenantId, organizationId };
  await withTx(db, s, systemActor('test'), async (tx) => {
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
  return s;
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

describe('AuditService.verifyChain', () => {
  it('is ok for the current month and counts the rows', async () => {
    const month = new Date().toISOString().slice(0, 7);
    const result = await service.verifyChain(scope.tenantId, month);
    expect(result).toMatchObject({ tenantId: scope.tenantId, month, ok: true, firstBadSeq: null });
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
        kind: 'staff',
        name: 'Second org',
        zitadelOrgId: `zitadel-${organizationId}`,
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
