// The sync and the lock-expiry job call ZITADEL with no transaction open, against the real store and Postgres: during
// each ZITADEL call no connection of this database sits idle in a transaction, and a write that committed while
// ZITADEL was being called is never overwritten (the row version is the real `updated_at`).
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import { idpOrgs, organizations, tenants } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db.module';
import { type TxScope, systemActor, withTx } from '../db/tx';
import { UserLocks } from './user-locks';
import { UserMirror } from './user-mirror';
import type { UsersSyncData } from './users.constants';
import { FakeZitadel, fakeQueue, zUser } from './users.fakes';
import { SqlUsersStore, type UserUpdate } from './users.store';
import type { ZitadelAdminClient, ZitadelUser } from './zitadel-admin.client';

let testDb: TestDatabase;
let appPool: Pool;
let adminPool: Pool;
let db: Db;
let store: SqlUsersStore;

/** Connections of this database inside a transaction that is waiting on the app, as ZITADEL calls would leave them. */
async function idleInTransaction(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = $1 AND state LIKE 'idle in transaction%'`,
    [testDb.name],
  );
  return rows[0]?.n ?? -1;
}

interface Fixture {
  scope: TxScope;
  userId: string;
  zitadelUserId: string;
  zitadelOrgId: string;
}

async function fixture(status: 'active' | 'invited' | 'inactive'): Promise<Fixture> {
  const tenantId = randomUUID();
  const entityId = randomUUID();
  const idpOrgId = randomUUID();
  const scope = { tenantId, organizationId: entityId };
  const zitadelOrgId = `z-${tenantId}`;
  const zitadelUserId = `u-${tenantId}`;
  const userId = await withTx(db, scope, systemActor('test'), async (tx) => {
    await tx.insert(tenants).values({ id: tenantId });
    await tx.insert(organizations).values({
      id: entityId,
      tenantId,
      organizationId: entityId,
      code: 'TR',
      name: 'Techrida',
      legalName: 'Techrida Pvt. Ltd.',
      isDefault: true,
    });
    await tx.insert(idpOrgs).values({
      id: idpOrgId,
      tenantId,
      zitadelOrgId,
      kind: 'staff',
      name: 'Techrida staff',
    });
    return store.insertUser(tx, scope, {
      zitadelUserId,
      idpOrgId,
      email: 'mina@techrida.test',
      displayName: 'Mina Gurung',
      status,
    });
  });
  return { scope, userId, zitadelUserId, zitadelOrgId };
}

const write = (f: Fixture, update: UserUpdate) =>
  withTx(db, f.scope, systemActor('test'), (tx) => store.updateUser(tx, f.userId, update));

const adminLock = () => ({ reason: 'admin' as const, lockedAt: new Date(), until: null });

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 4 });
  appPool.on('error', () => undefined);
  adminPool = new Pool({ connectionString: testDb.adminUrl, max: 1 });
  adminPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  store = new SqlUsersStore(db);
}, 180_000);

afterAll(async () => {
  await appPool?.end();
  await adminPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

describe('UserMirror.apply against Postgres', () => {
  it('re-reads ZITADEL with no transaction open and does not write over an admin lock that committed meanwhile', async () => {
    const f = await fixture('invited');
    const zitadel = new FakeZitadel();
    zitadel.users.set(f.zitadelUserId, zUser(f.zitadelUserId, { orgId: f.zitadelOrgId }));
    const mirror = new UserMirror(
      db,
      store,
      zitadel.asClient(),
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    const real = zitadel.getUser.bind(zitadel);
    const open: number[] = [];
    let calls = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation(async (id: string) => {
      calls += 1;
      open.push(await idleInTransaction());
      const answer = await real(id);
      if (calls === 2) {
        // ZITADEL answered "active"; then an admin locked the person, the row first and ZITADEL just before commit.
        await write(f, {
          email: 'mina@techrida.test',
          displayName: 'Mina Gurung',
          status: 'inactive',
          lock: adminLock(),
        });
        zitadel.users.set(
          id,
          zUser(id, { orgId: f.zitadelOrgId, status: 'inactive', locked: true }),
        );
      }
      return answer;
    });

    await mirror.syncUser(f.zitadelUserId);

    expect(open).toEqual([0, 0, 0]);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);
});

describe('UserLocks.expire against Postgres', () => {
  /** ZITADEL holding one person locked; `duringUnlock` runs after it unlocked them. */
  function lockZitadel(f: Fixture, duringUnlock?: () => Promise<void>) {
    const open: number[] = [];
    const calls: string[] = [];
    let user: ZitadelUser = zUser(f.zitadelUserId, {
      orgId: f.zitadelOrgId,
      status: 'inactive',
      locked: true,
    });
    const client = {
      async getUser() {
        open.push(await idleInTransaction());
        calls.push('getUser');
        return user;
      },
      async unlockUser() {
        open.push(await idleInTransaction());
        calls.push('unlockUser');
        user = { ...user, status: 'active', locked: false };
        await duringUnlock?.();
      },
      async lockUser() {
        open.push(await idleInTransaction());
        calls.push('lockUser');
        user = { ...user, status: 'inactive', locked: true };
      },
    };
    return { open, calls, client: client as unknown as ZitadelAdminClient };
  }

  async function timedLock(f: Fixture, now: Date) {
    await write(f, {
      email: 'mina@techrida.test',
      displayName: 'Mina Gurung',
      status: 'inactive',
      lock: {
        reason: 'failed_sign_ins',
        lockedAt: new Date(now.getTime() - 20 * 60_000),
        until: new Date(now.getTime() - 5 * 60_000),
      },
    });
  }

  it('reads and unlocks in ZITADEL with no transaction open, then unlocks here, audited', async () => {
    const now = new Date();
    const f = await fixture('active');
    await timedLock(f, now);
    const zitadel = lockZitadel(f);
    const locks = new UserLocks(db, store, zitadel.client, new AuditService(db));

    expect(await locks.expire(now)).toMatchObject({ unlocked: 1 });

    expect(zitadel.calls).toEqual(['getUser', 'unlockUser']);
    expect(zitadel.open).toEqual([0, 0]);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'active',
      lockReason: null,
    });
    const { rows } = await adminPool.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = 'users.unlocked'`,
      [f.userId],
    );
    expect(rows).toEqual([{ actor_id: 'system:users.lock-expiry' }]);
  }, 60_000);

  it('keeps an admin lock that committed while ZITADEL was unlocking, and locks the person again there', async () => {
    const now = new Date();
    const f = await fixture('active');
    await timedLock(f, now);
    const zitadel = lockZitadel(f, () =>
      write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: adminLock(),
      }),
    );
    const locks = new UserLocks(db, store, zitadel.client, new AuditService(db));

    expect(await locks.expire(now)).toMatchObject({ unlocked: 0, postponed: 0, cleared: 0 });

    expect(zitadel.calls).toEqual(['getUser', 'unlockUser', 'lockUser']);
    expect(zitadel.open).toEqual([0, 0, 0]);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
  }, 60_000);
});
