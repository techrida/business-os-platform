// Admin user mutations (status actions, invite, setRoles), sync, and lock-expiry all call ZITADEL with no
// transaction open, against the real store and Postgres: during every ZITADEL call no connection sits idle in
// a transaction, the tenant audit lock is free for concurrent audited writes, concurrent row changes are never
// overwritten (409 + ZITADEL compensated), DB write failures compensate ZITADEL, slow multi-call invites stay
// clear of idle_in_transaction_session_timeout, and parallel admin writes in one tenant never deadlock or 503.
import 'reflect-metadata';

import { randomUUID } from 'node:crypto';

import type { RoleKey } from '@bos/contracts';
import { departments, idpOrgs, organizations, tenants } from '@bos/db';
import { createTestDatabase, type TestDatabase } from '@bos/db/testing';
import { ConflictException, Logger } from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../db/tx';
import { configureTx } from '../db/tx-settings';
import { UserLocks } from './user-locks';
import { UserMirror } from './user-mirror';
import { type UserStatusAction, UserStatusService } from './user-status';
import type { UsersSyncData } from './users.constants';
import { FakeZitadel, fakeQueue, zUser } from './users.fakes';
import { UsersService } from './users.service';
import { SqlUsersStore, type UserUpdate } from './users.store';
import {
  type ZitadelAdminClient,
  ZitadelHttpError,
  type ZitadelUser,
  type ZitadelUserPage,
} from './zitadel-admin.client';

let testDb: TestDatabase;
let appPool: Pool;
let adminPool: Pool;
let db: Db;
let store: SqlUsersStore;
let audit: AuditService;

/** Connections of this database inside a transaction that is waiting on the app, as ZITADEL calls would leave them. */
async function idleInTransaction(): Promise<number> {
  const { rows } = await adminPool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE datname = $1 AND state LIKE 'idle in transaction%'`,
    [testDb.name],
  );
  return rows[0]?.n ?? -1;
}

/** Runs a real audited write in the same tenant; fails with 55P03 if the tenant audit lock is held. */
async function concurrentAuditWrite(scope: TxScope, tag: string): Promise<void> {
  await withTx(db, scope, systemActor('concurrent-writer'), (tx) =>
    audit.record(tx, {
      action: 'test.concurrent',
      entityType: 'tenants',
      entityId: scope.tenantId,
      meta: { tag },
    }),
  );
}

interface Fixture {
  scope: TxScope;
  idpOrgId: string;
  departmentId: string;
  adminId: string;
  userId: string;
  zitadelUserId: string;
  zitadelOrgId: string;
}

const adminActor = (adminId: string): Actor => ({
  kind: 'user',
  id: adminId,
  correlationId: `corr-${randomUUID()}`,
});

async function fixture(
  status: 'active' | 'invited' | 'inactive',
  opts: { roles?: RoleKey[]; lock?: UserUpdate['lock'] } = {},
): Promise<Fixture> {
  const tenantId = randomUUID();
  const entityId = randomUUID();
  const idpOrgId = randomUUID();
  const departmentId = randomUUID();
  const scope = { tenantId, organizationId: entityId };
  const zitadelOrgId = `z-${tenantId}`;
  const zitadelUserId = `u-${tenantId}`;
  const { adminId, userId } = await withTx(db, scope, systemActor('test'), async (tx) => {
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
    await tx
      .insert(departments)
      .values({ id: departmentId, tenantId, organizationId: entityId, name: 'Operations' });
    const adminId = await store.insertUser(tx, scope, {
      zitadelUserId: `admin-${tenantId}`,
      idpOrgId,
      email: 'admin@techrida.test',
      displayName: 'Admin Founder',
      status: 'active',
    });
    await store.ensureDefaultMembership(tx, tenantId, entityId, adminId);
    await store.replaceRoles(tx, scope, adminId, ['founder']);
    const userId = await store.insertUser(tx, scope, {
      zitadelUserId,
      idpOrgId,
      email: 'mina@techrida.test',
      displayName: 'Mina Gurung',
      status,
    });
    await store.ensureDefaultMembership(tx, tenantId, entityId, userId);
    if (opts.roles) await store.replaceRoles(tx, scope, userId, opts.roles);
    if (opts.lock) {
      await store.updateUser(tx, userId, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: opts.lock,
      });
    }
    return { adminId, userId };
  });
  return { scope, idpOrgId, departmentId, adminId, userId, zitadelUserId, zitadelOrgId };
}

const write = (f: Fixture, update: UserUpdate) =>
  withTx(db, f.scope, systemActor('test'), (tx) => store.updateUser(tx, f.userId, update));

const adminLock = () => ({ reason: 'admin' as const, lockedAt: new Date(), until: null });

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Full in-memory ZITADEL double that runs an async hook on every RPC so tests can probe Postgres mid-call. */
class RecordingZitadel {
  users = new Map<string, ZitadelUser>();
  grants = new Map<string, RoleKey[]>();
  calls: string[] = [];
  seq = 0;
  onCall: ((op: string, userId?: string) => Promise<void>) | null = null;

  private async observe(op: string, userId?: string) {
    this.calls.push(userId ? `${op}:${userId}` : op);
    if (this.onCall) await this.onCall(op, userId);
  }

  async createHuman(
    orgId: string,
    input: { email: string; givenName: string; familyName: string },
  ): Promise<string> {
    await this.observe('createHuman', input.email);
    const dup = [...this.users.values()].find(
      (u) => u.orgId === orgId && u.email?.toLowerCase() === input.email.toLowerCase(),
    );
    if (dup) throw new ZitadelHttpError('/v2/users/new', 409, 'already exists');
    this.seq += 1;
    const id = `z-new-${orgId}-${this.seq}`;
    this.users.set(id, {
      id,
      orgId,
      email: input.email,
      displayName: `${input.givenName} ${input.familyName}`,
      status: 'invited',
      createdAt: new Date(),
    });
    return id;
  }

  async setGrants(userId: string, _orgId: string, roles: readonly RoleKey[]): Promise<void> {
    await this.observe(`setGrants:${[...roles].sort().join(',')}`, userId);
    this.grants.set(userId, [...roles]);
  }

  async sendInviteCode(userId: string): Promise<void> {
    await this.observe('sendInviteCode', userId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.observe('deleteUser', userId);
    this.users.delete(userId);
    this.grants.delete(userId);
  }

  async getUser(userId: string): Promise<ZitadelUser | null> {
    await this.observe('getUser', userId);
    return this.users.get(userId) ?? null;
  }

  async listUsers(orgId: string, cursor?: string | null): Promise<ZitadelUserPage> {
    await this.observe('listUsers', orgId);
    const all = [...this.users.values()].filter((u) => u.orgId === orgId);
    const offset = cursor ? Number(cursor) : 0;
    return { users: all.slice(offset), nextCursor: null, totalResult: all.length };
  }

  async listGrants(userId: string): Promise<RoleKey[]> {
    await this.observe('listGrants', userId);
    return [...(this.grants.get(userId) ?? [])];
  }

  async lockUser(userId: string): Promise<void> {
    await this.observe('lock', userId);
    const u = this.users.get(userId);
    if (u) Object.assign(u, { status: 'inactive', locked: true });
  }

  async unlockUser(userId: string): Promise<void> {
    await this.observe('unlock', userId);
    const u = this.users.get(userId);
    if (u) Object.assign(u, { status: 'active', locked: false });
  }

  async deactivateUser(userId: string): Promise<void> {
    await this.observe('deactivate', userId);
    const u = this.users.get(userId);
    if (u) Object.assign(u, { status: 'inactive', locked: false });
  }

  async reactivateUser(userId: string): Promise<void> {
    await this.observe('reactivate', userId);
    const u = this.users.get(userId);
    if (u) Object.assign(u, { status: 'active', locked: false });
  }

  asClient(): ZitadelAdminClient {
    return this as unknown as ZitadelAdminClient;
  }
}

beforeAll(async () => {
  testDb = await createTestDatabase();
  appPool = new Pool({ connectionString: testDb.appUrl, max: 16 });
  appPool.on('error', () => undefined);
  adminPool = new Pool({ connectionString: testDb.adminUrl, max: 2 });
  adminPool.on('error', () => undefined);
  db = drizzle({ client: appPool });
  store = new SqlUsersStore(db);
  audit = new AuditService(db);
}, 180_000);

afterAll(async () => {
  configureTx({});
  await appPool?.end();
  await adminPool?.end();
  await testDb?.drop();
});

beforeEach(() => {
  vi.restoreAllMocks();
  configureTx({});
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
    const locks = new UserLocks(db, store, zitadel.client, audit);

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
    const locks = new UserLocks(db, store, zitadel.client, audit);

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

describe('Admin status actions outside any tx against Postgres (FU1)', () => {
  it.each<{
    label: string;
    initial: 'active' | 'inactive';
    lock?: UserUpdate['lock'];
    action: UserStatusAction;
    expectedCalls: string[];
    expectedAudit: string;
  }>([
    {
      label: 'lock active user',
      initial: 'active',
      action: 'lock',
      expectedCalls: ['lock'],
      expectedAudit: 'users.locked',
    },
    {
      label: 'lock user under failed_sign_ins (ITEM 2)',
      initial: 'inactive',
      lock: {
        reason: 'failed_sign_ins',
        lockedAt: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
      },
      action: 'lock',
      expectedCalls: ['lock'],
      expectedAudit: 'users.locked',
    },
    {
      label: 'unlock locked user',
      initial: 'inactive',
      lock: adminLock(),
      action: 'unlock',
      expectedCalls: ['unlock'],
      expectedAudit: 'users.unlocked',
    },
    {
      label: 'deactivate active user',
      initial: 'active',
      action: 'deactivate',
      expectedCalls: ['deactivate'],
      expectedAudit: 'users.deactivated',
    },
    {
      label: 'deactivate locked user',
      initial: 'inactive',
      lock: adminLock(),
      action: 'deactivate',
      expectedCalls: ['unlock', 'deactivate'],
      expectedAudit: 'users.deactivated',
    },
    {
      label: 'reactivate inactive user',
      initial: 'inactive',
      action: 'reactivate',
      expectedCalls: ['reactivate'],
      expectedAudit: 'users.reactivated',
    },
  ])(
    '$label: holds no tx or tenant audit lock during every ZITADEL call',
    async ({ initial, lock, action, expectedCalls, expectedAudit }) => {
      const f = await fixture(initial, { lock });
      const zitadel = new RecordingZitadel();
      zitadel.users.set(
        f.zitadelUserId,
        zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: initial, locked: Boolean(lock) }),
      );
      const idle: number[] = [];
      let concurrentWrites = 0;
      zitadel.onCall = async (op) => {
        idle.push(await idleInTransaction());
        // If the tenant audit lock were held across the ZITADEL call, this would block and fail with 55P03.
        await concurrentAuditWrite(f.scope, `during-${action}-${op}`);
        concurrentWrites += 1;
      };
      const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

      await statusService.apply(f.scope, adminActor(f.adminId), f.userId, action);

      expect(zitadel.calls).toEqual(expectedCalls.map((c) => `${c}:${f.zitadelUserId}`));
      expect(idle).toEqual(expectedCalls.map(() => 0));
      expect(concurrentWrites).toBe(expectedCalls.length);
      const { rows } = await adminPool.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = $2`,
        [f.userId, expectedAudit],
      );
      expect(rows).toEqual([{ actor_id: f.adminId }]);
    },
    60_000,
  );

  it.each<{
    label: string;
    initial: 'active' | 'inactive';
    lock?: UserUpdate['lock'];
    action: UserStatusAction;
    expectedCalls: string[];
  }>([
    {
      label: 'lock',
      initial: 'active',
      action: 'lock',
      expectedCalls: ['lock', 'unlock'],
    },
    {
      label: 'unlock',
      initial: 'inactive',
      lock: adminLock(),
      action: 'unlock',
      expectedCalls: ['unlock', 'lock'],
    },
    {
      label: 'deactivate',
      initial: 'active',
      action: 'deactivate',
      expectedCalls: ['deactivate', 'reactivate'],
    },
    {
      label: 'deactivate locked user',
      initial: 'inactive',
      lock: adminLock(),
      action: 'deactivate',
      expectedCalls: ['unlock', 'deactivate', 'reactivate', 'lock'],
    },
    {
      label: 'reactivate',
      initial: 'inactive',
      action: 'reactivate',
      expectedCalls: ['reactivate', 'deactivate'],
    },
  ])(
    '$label: concurrent write during ZITADEL call returns 409 conflict, preserves the concurrent write, and compensates ZITADEL',
    async ({ initial, lock, action, expectedCalls }) => {
      const f = await fixture(initial, { lock });
      const zitadel = new RecordingZitadel();
      zitadel.users.set(
        f.zitadelUserId,
        zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: initial, locked: Boolean(lock) }),
      );
      let mutated = false;
      zitadel.onCall = async () => {
        if (mutated) return;
        mutated = true;
        // Another writer updates the same user row while ZITADEL is in flight (bumps updated_at).
        await write(f, {
          email: 'mina@techrida.test',
          displayName: 'Mina Concurrent',
          status: initial,
          ...(lock ? { lock } : {}),
        });
      };
      const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

      const error = await statusService
        .apply(f.scope, adminActor(f.adminId), f.userId, action)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
      expect(zitadel.calls).toEqual(expectedCalls.map((c) => `${c}:${f.zitadelUserId}`));
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        displayName: 'Mina Concurrent',
        status: initial,
        lockReason: lock?.reason ?? null,
      });
    },
    60_000,
  );

  it('compensates ZITADEL and rolls back cleanly when Phase (C) DB write fails after ZITADEL', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'inactive', locked: true }),
    );
    const failingAudit = {
      record: vi.fn(() => Promise.reject(new Error('audit write boom'))),
    } as unknown as AuditService;
    const statusService = new UserStatusService(db, store, zitadel.asClient(), failingAudit);

    await expect(
      statusService.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
    ).rejects.toThrow('audit write boom');

    expect(zitadel.calls).toEqual([
      `unlock:${f.zitadelUserId}`,
      `deactivate:${f.zitadelUserId}`,
      `reactivate:${f.zitadelUserId}`,
      `lock:${f.zitadelUserId}`,
    ]);
    // Postgres rolled back store.updateUser when audit.record threw.
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);
});

describe('Admin invite and setRoles outside any tx against Postgres (FU1)', () => {
  function services(zitadel: RecordingZitadel) {
    const mirror = new UserMirror(
      db,
      store,
      zitadel.asClient(),
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    const users = new UsersService(mirror, store, zitadel.asClient(), db, audit);
    return { mirror, users };
  }

  it('invite (with placement and finishInvite repair) holds no tx or tenant audit lock during every ZITADEL call', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const idle: number[] = [];
    let concurrentWrites = 0;
    zitadel.onCall = async (op) => {
      idle.push(await idleInTransaction());
      await concurrentAuditWrite(f.scope, `invite-${op}`);
      concurrentWrites += 1;
    };
    const { users } = services(zitadel);

    // 1. Fresh invite with department placement.
    const invited = await users.invite(
      f.scope,
      adminActor(f.adminId),
      {
        email: 'asha@techrida.test',
        givenName: 'Asha',
        familyName: 'Rai',
        roles: ['accountant'],
      },
      { departmentId: f.departmentId, level: 'staff' },
    );

    expect(zitadel.calls).toEqual([
      'createHuman:asha@techrida.test',
      `setGrants:accountant:${invited.zitadelUserId}`,
      `sendInviteCode:${invited.zitadelUserId}`,
    ]);
    expect(idle).toEqual([0, 0, 0]);
    expect(concurrentWrites).toBe(3);
    expect(await store.membershipsOf(db, f.scope.tenantId, invited.userId)).toEqual([
      expect.objectContaining({ departmentId: f.departmentId, level: 'staff' }),
    ]);

    // 2. Repair path (finishInvite): an open invite already exists in ZITADEL with no mirror row yet.
    zitadel.calls = [];
    idle.length = 0;
    concurrentWrites = 0;
    zitadel.users.set('z-orphan', {
      id: 'z-orphan',
      orgId: f.zitadelOrgId,
      email: 'repair@techrida.test',
      displayName: 'Repair Person',
      status: 'invited',
      createdAt: new Date(),
    });
    const repaired = await users.invite(f.scope, adminActor(f.adminId), {
      email: 'repair@techrida.test',
      givenName: 'Repair',
      familyName: 'Person',
      roles: ['finance'],
    });
    expect(repaired.zitadelUserId).toBe('z-orphan');
    expect(idle.every((n) => n === 0)).toBe(true);
    expect(concurrentWrites).toBe(idle.length);
    expect(await store.rolesOf(db, f.scope.tenantId, repaired.userId)).toEqual(['finance']);
  }, 60_000);

  it('invite with 3 slow ZITADEL calls does not hit idle_in_transaction_session_timeout', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const idle: number[] = [];
    zitadel.onCall = async () => {
      idle.push(await idleInTransaction());
      // 3 calls × 80ms = 240ms > 120ms idle_in_transaction_session_timeout.
      await sleep(80);
    };
    const { users } = services(zitadel);

    configureTx({ idleInTxTimeoutMs: 120 });
    try {
      const result = await users.invite(f.scope, adminActor(f.adminId), {
        email: 'slow@techrida.test',
        givenName: 'Slow',
        familyName: 'Invite',
        roles: ['sales'],
      });
      expect(idle).toEqual([0, 0, 0]);
      expect(await store.findById(db, f.scope, result.userId)).toMatchObject({
        email: 'slow@techrida.test',
        status: 'invited',
      });
    } finally {
      configureTx({});
    }
  }, 60_000);

  it('invite compensates ZITADEL (clears grants and deletes user) when the Phase (C) DB write fails', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);
    vi.spyOn(store, 'placeMembership').mockRejectedValueOnce(new Error('placement boom'));

    await expect(
      users.invite(
        f.scope,
        adminActor(f.adminId),
        {
          email: 'rollback@techrida.test',
          givenName: 'Roll',
          familyName: 'Back',
          roles: ['sales'],
        },
        { departmentId: f.departmentId, level: 'staff' },
      ),
    ).rejects.toThrow('placement boom');

    const zId = `z-new-${f.zitadelOrgId}-1`;
    expect(zitadel.calls).toEqual([
      'createHuman:rollback@techrida.test',
      `setGrants:sales:${zId}`,
      `sendInviteCode:${zId}`,
      `setGrants::${zId}`,
      `deleteUser:${zId}`,
    ]);
    expect(await store.findByZitadelId(db, zId)).toBeNull();
  }, 60_000);

  it('setRoles holds no tx or tenant audit lock during setGrants, and compensates on concurrent change or DB failure', async () => {
    const f = await fixture('active', { roles: ['accountant'] });
    const zitadel = new RecordingZitadel();
    zitadel.users.set(f.zitadelUserId, zUser(f.zitadelUserId, { orgId: f.zitadelOrgId }));
    zitadel.grants.set(f.zitadelUserId, ['accountant']);
    const idle: number[] = [];
    let concurrentWrites = 0;
    zitadel.onCall = async (op) => {
      idle.push(await idleInTransaction());
      await concurrentAuditWrite(f.scope, `setRoles-${op}`);
      concurrentWrites += 1;
    };
    const { users } = services(zitadel);

    // 1. Clean setRoles: zero idle-in-tx, tenant audit lock free.
    await users.setRoles(f.scope, adminActor(f.adminId), f.userId, ['finance']);
    expect(idle).toEqual([0]);
    expect(concurrentWrites).toBe(1);
    expect(await store.rolesOf(db, f.scope.tenantId, f.userId)).toEqual(['finance']);

    // 2. Concurrent role change committed while setGrants was in flight -> 409 conflict + ZITADEL restored.
    zitadel.calls = [];
    let raced = false;
    zitadel.onCall = async () => {
      if (raced) return;
      raced = true;
      await withTx(db, f.scope, systemActor('other-admin'), (tx) =>
        store.replaceRoles(tx, f.scope, f.userId, ['sales']),
      );
    };
    const conflict = await users
      .setRoles(f.scope, adminActor(f.adminId), f.userId, ['management'])
      .catch((e: unknown) => e);
    expect(conflict).toBeInstanceOf(ConflictException);
    expect((conflict as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
    expect(zitadel.calls).toEqual([
      `setGrants:management:${f.zitadelUserId}`,
      `setGrants:finance:${f.zitadelUserId}`,
    ]);
    expect(await store.rolesOf(db, f.scope.tenantId, f.userId)).toEqual(['sales']);

    // 3. DB write failure in Phase (C) -> compensates ZITADEL back to ['sales'].
    zitadel.calls = [];
    zitadel.onCall = null;
    vi.spyOn(store, 'replaceRoles').mockRejectedValueOnce(new Error('roles write boom'));
    await expect(
      users.setRoles(f.scope, adminActor(f.adminId), f.userId, ['finance']),
    ).rejects.toThrow('roles write boom');
    expect(zitadel.calls).toEqual([
      `setGrants:finance:${f.zitadelUserId}`,
      `setGrants:sales:${f.zitadelUserId}`,
    ]);
    expect(await store.rolesOf(db, f.scope.tenantId, f.userId)).toEqual(['sales']);
  }, 60_000);
});

describe('Concurrent admin actions and invites in one tenant against Postgres (FU1)', () => {
  it('N parallel status actions, setRoles, invites, and audited writes settle with only 2xx or 409 (never 500, 40P01, or 55P03)', async () => {
    const f = await fixture('active', { roles: ['accountant'] });
    const extraUsers = await withTx(db, f.scope, systemActor('test'), async (tx) => {
      const ids: { id: string; zId: string; status: 'active' | 'inactive'; locked: boolean }[] = [];
      for (let i = 0; i < 4; i += 1) {
        const zId = `extra-${i}-${f.scope.tenantId}`;
        const status = i % 2 === 0 ? 'active' : 'inactive';
        const id = await store.insertUser(tx, f.scope, {
          zitadelUserId: zId,
          idpOrgId: f.idpOrgId,
          email: `extra-${i}@techrida.test`,
          displayName: `Extra ${i}`,
          status,
        });
        await store.ensureDefaultMembership(tx, f.scope.tenantId, f.scope.organizationId, id);
        await store.replaceRoles(tx, f.scope, id, ['sales']);
        if (i === 1) {
          await store.updateUser(tx, id, {
            email: `extra-${i}@techrida.test`,
            displayName: `Extra ${i}`,
            status: 'inactive',
            lock: adminLock(),
          });
        }
        ids.push({ id, zId, status, locked: i === 1 });
      }
      return ids;
    });

    const zitadel = new RecordingZitadel();
    zitadel.users.set(f.zitadelUserId, zUser(f.zitadelUserId, { orgId: f.zitadelOrgId }));
    zitadel.grants.set(f.zitadelUserId, ['accountant']);
    for (const u of extraUsers) {
      zitadel.users.set(
        u.zId,
        zUser(u.zId, { orgId: f.zitadelOrgId, status: u.status, locked: u.locked }),
      );
      zitadel.grants.set(u.zId, ['sales']);
    }
    // Small jitter inside every ZITADEL call so Phases (A), (B), and (C) genuinely overlap across workers.
    let tick = 0;
    zitadel.onCall = async () => {
      tick += 1;
      await sleep(5 + (tick % 4) * 5);
    };

    const mirror = new UserMirror(
      db,
      store,
      zitadel.asClient(),
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    const users = new UsersService(mirror, store, zitadel.asClient(), db, audit);
    const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);
    const actor = adminActor(f.adminId);

    const tasks: Promise<unknown>[] = [
      // 4 parallel invites (2 with placement, 2 without).
      users.invite(
        f.scope,
        actor,
        { email: 'p1@techrida.test', givenName: 'P', familyName: 'One', roles: ['sales'] },
        { departmentId: f.departmentId, level: 'staff' },
      ),
      users.invite(
        f.scope,
        actor,
        { email: 'p2@techrida.test', givenName: 'P', familyName: 'Two', roles: ['accountant'] },
        { departmentId: f.departmentId, level: 'manager' },
      ),
      users.invite(f.scope, actor, {
        email: 'p3@techrida.test',
        givenName: 'P',
        familyName: 'Three',
        roles: [],
      }),
      users.invite(f.scope, actor, {
        email: 'p4@techrida.test',
        givenName: 'P',
        familyName: 'Four',
        roles: ['finance'],
      }),
      // Contending setRoles on the same user + disjoint setRoles on another.
      users.setRoles(f.scope, actor, f.userId, ['finance']),
      users.setRoles(f.scope, actor, f.userId, ['management']),
      users.setRoles(f.scope, actor, extraUsers[0]!.id, ['accountant']),
      users.setRoles(f.scope, actor, extraUsers[2]!.id, ['finance']),
      // Contending status actions on the same user + disjoint status actions on others.
      statusService.apply(f.scope, actor, f.userId, 'lock'),
      statusService.apply(f.scope, actor, f.userId, 'deactivate'),
      statusService.apply(f.scope, actor, extraUsers[0]!.id, 'lock'),
      statusService.apply(f.scope, actor, extraUsers[1]!.id, 'unlock'),
      statusService.apply(f.scope, actor, extraUsers[2]!.id, 'deactivate'),
      statusService.apply(f.scope, actor, extraUsers[3]!.id, 'reactivate'),
      // Concurrent audited writes in the same tenant.
      concurrentAuditWrite(f.scope, 'parallel-1'),
      concurrentAuditWrite(f.scope, 'parallel-2'),
    ];

    const settled = await Promise.allSettled(tasks);
    const unexpected = settled.filter(
      (r): r is PromiseRejectedResult =>
        r.status === 'rejected' && !(r.reason instanceof ConflictException),
    );
    expect(unexpected.map((r) => String(r.reason))).toEqual([]);

    const succeeded = settled.filter((r) => r.status === 'fulfilled').length;
    // All 4 distinct invites, 2 audited writes, and at least one winner per user must succeed.
    expect(succeeded).toBeGreaterThanOrEqual(11);
  }, 60_000);
});
