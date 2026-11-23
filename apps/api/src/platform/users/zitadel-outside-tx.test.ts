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
import {
  ConflictException,
  ForbiddenException,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Queue } from 'bullmq';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AuditService } from '../audit/audit.service';
import type { Db } from '../db/db.module';
import { type Actor, type TxScope, systemActor, withTx } from '../db/tx';
import { configureTx } from '../db/tx-settings';
import { assertWithinOperationDeadline, withFounderRemovalLease } from './identity-reconcile';
import { UserLocks } from './user-locks';
import { UserMirror, UserSyncContendedError } from './user-mirror';
import { type UserStatusAction, UserStatusService } from './user-status';
import { lockoutPinnedCursor, type UsersSyncData } from './users.constants';
import { applyZitadelStatusTransition, FakeZitadel, fakeQueue, zUser } from './users.fakes';
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
  grantOrgs = new Map<string, string>();
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

  async setGrants(userId: string, orgId: string, roles: readonly RoleKey[]): Promise<void> {
    await this.observe(`setGrants:${[...roles].sort().join(',')}`, userId);
    this.grants.set(userId, [...roles]);
    this.grantOrgs.set(userId, orgId);
  }

  async sendInviteCode(userId: string): Promise<void> {
    await this.observe('sendInviteCode', userId);
  }

  async deleteUser(userId: string): Promise<void> {
    await this.observe('deleteUser', userId);
    this.users.delete(userId);
    this.grants.delete(userId);
    this.grantOrgs.delete(userId);
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

  async listGrants(userId: string, orgId: string): Promise<RoleKey[]> {
    await this.observe('listGrants', userId);
    if (!orgId) return [];
    const ownerOrg = this.grantOrgs.get(userId) ?? this.users.get(userId)?.orgId;
    if (ownerOrg !== undefined && ownerOrg !== orgId) return [];
    return [...(this.grants.get(userId) ?? [])];
  }

  async lockUser(userId: string): Promise<void> {
    applyZitadelStatusTransition(this.users.get(userId), 'lock');
    await this.observe('lock', userId);
  }

  async unlockUser(userId: string): Promise<void> {
    applyZitadelStatusTransition(this.users.get(userId), 'unlock');
    await this.observe('unlock', userId);
  }

  async deactivateUser(userId: string): Promise<void> {
    applyZitadelStatusTransition(this.users.get(userId), 'deactivate');
    await this.observe('deactivate', userId);
  }

  async reactivateUser(userId: string): Promise<void> {
    applyZitadelStatusTransition(this.users.get(userId), 'reactivate');
    await this.observe('reactivate', userId);
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
    zitadel?: { status: 'active' | 'inactive'; locked: boolean };
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
      label: 'lock user under failed_sign_ins (already locked in ZITADEL -> skips lockUser)',
      initial: 'inactive',
      lock: {
        reason: 'failed_sign_ins',
        lockedAt: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
      },
      action: 'lock',
      expectedCalls: ['getUser'],
      expectedAudit: 'users.locked',
    },
    {
      label:
        'lock user under failed_sign_ins (lock-expiry race: ZITADEL already unlocked -> calls lockUser)',
      initial: 'inactive',
      lock: {
        reason: 'failed_sign_ins',
        lockedAt: new Date(Date.now() - 60_000),
        until: new Date(Date.now() + 60_000),
      },
      zitadel: { status: 'active', locked: false },
      action: 'lock',
      expectedCalls: ['getUser', 'lock'],
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
    async ({ initial, lock, zitadel: zInitial, action, expectedCalls, expectedAudit }) => {
      const f = await fixture(initial, { lock });
      const zitadel = new RecordingZitadel();
      zitadel.users.set(
        f.zitadelUserId,
        zUser(f.zitadelUserId, {
          orgId: f.zitadelOrgId,
          status: zInitial?.status ?? initial,
          locked: zInitial?.locked ?? Boolean(lock),
        }),
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
    expectedZitadel: { status: 'active' | 'inactive'; locked: boolean };
    expectedRow: { status: 'active' | 'inactive'; lockReason: 'admin' | null };
  }>([
    {
      label: 'lock',
      initial: 'active',
      action: 'lock',
      expectedCalls: ['lock', 'getUser'],
      expectedZitadel: { status: 'inactive', locked: true },
      expectedRow: { status: 'inactive', lockReason: 'admin' },
    },
    {
      label: 'unlock',
      initial: 'inactive',
      lock: adminLock(),
      action: 'unlock',
      expectedCalls: ['unlock', 'lock'],
      expectedZitadel: { status: 'inactive', locked: true },
      expectedRow: { status: 'inactive', lockReason: 'admin' },
    },
    {
      label: 'deactivate',
      initial: 'active',
      action: 'deactivate',
      expectedCalls: ['deactivate', 'getUser'],
      expectedZitadel: { status: 'inactive', locked: false },
      expectedRow: { status: 'inactive', lockReason: null },
    },
    {
      label: 'deactivate locked user',
      initial: 'inactive',
      lock: adminLock(),
      action: 'deactivate',
      expectedCalls: ['unlock', 'deactivate', 'getUser'],
      expectedZitadel: { status: 'inactive', locked: false },
      expectedRow: { status: 'inactive', lockReason: 'admin' },
    },
    {
      label: 'reactivate',
      initial: 'inactive',
      action: 'reactivate',
      expectedCalls: ['reactivate', 'deactivate'],
      expectedZitadel: { status: 'inactive', locked: false },
      expectedRow: { status: 'inactive', lockReason: null },
    },
  ])(
    '$label: plain DB write failure closes and flags the person in the row and closes ZITADEL, never reopens (round 3)',
    async ({ initial, lock, action, expectedCalls, expectedZitadel, expectedRow }) => {
      const f = await fixture(initial, { lock });
      const zitadel = new RecordingZitadel();
      zitadel.users.set(
        f.zitadelUserId,
        zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: initial, locked: Boolean(lock) }),
      );
      const failingAudit = {
        record: vi.fn(() => Promise.reject(new Error('audit write boom'))),
      } as unknown as AuditService;
      const statusService = new UserStatusService(db, store, zitadel.asClient(), failingAudit);

      await expect(
        statusService.apply(f.scope, adminActor(f.adminId), f.userId, action),
      ).rejects.toThrow('audit write boom');

      expect(zitadel.calls).toEqual(expectedCalls.map((c) => `${c}:${f.zitadelUserId}`));
      expect(zitadel.users.get(f.zitadelUserId)).toMatchObject(expectedZitadel);
      // The failed write rolled back; the reconcile then closed whatever was still open (its audit is a separate write).
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject(expectedRow);
    },
    60_000,
  );

  it('admin A deactivates while admin B commits a lock -> 409 conflict, ZITADEL is NOT reactivated, person stays shut out', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'active', locked: false }),
    );
    let raced = false;
    zitadel.onCall = async (op) => {
      if (raced || op !== 'deactivate') return;
      raced = true;
      // Admin B's lock committed while admin A's deactivate was in flight.
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: adminLock(),
      });
    };
    const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

    const error = await statusService
      .apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
    // Must NEVER call reactivate or unlock when the committed row or live ZITADEL state shows shut out.
    expect(zitadel.calls).toEqual([`deactivate:${f.zitadelUserId}`, `getUser:${f.zitadelUserId}`]);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: false });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);

  it.each<{
    label: string;
    initial: 'active' | 'inactive';
    lock?: UserUpdate['lock'];
    action: UserStatusAction;
    concurrentWrite: UserUpdate;
    expectedCalls: string[];
    expectedZitadel: { status: 'active' | 'inactive'; locked: boolean };
    expectedRow: { displayName: string; status: 'active' | 'inactive'; lockReason: string | null };
  }>([
    {
      label: 'unlock while concurrent rename (still locked) -> closes with lock',
      initial: 'inactive',
      lock: adminLock(),
      action: 'unlock',
      concurrentWrite: {
        email: 'mina@techrida.test',
        displayName: 'Mina Concurrent',
        status: 'inactive',
        lock: adminLock(),
      },
      expectedCalls: ['unlock', 'lock'],
      expectedZitadel: { status: 'inactive', locked: true },
      expectedRow: { displayName: 'Mina Concurrent', status: 'inactive', lockReason: 'admin' },
    },
    {
      label:
        'unlock while admin B deactivated -> closes with lock (the person was locked when the action began)',
      initial: 'inactive',
      lock: adminLock(),
      action: 'unlock',
      concurrentWrite: {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: null,
      },
      expectedCalls: ['unlock', 'lock'],
      expectedZitadel: { status: 'inactive', locked: true },
      expectedRow: { displayName: 'Mina Gurung', status: 'inactive', lockReason: 'admin' },
    },
    {
      label: 'reactivate while concurrent rename (still inactive) -> closes with deactivate',
      initial: 'inactive',
      action: 'reactivate',
      concurrentWrite: {
        email: 'mina@techrida.test',
        displayName: 'Mina Concurrent',
        status: 'inactive',
      },
      expectedCalls: ['reactivate', 'deactivate'],
      expectedZitadel: { status: 'inactive', locked: false },
      expectedRow: { displayName: 'Mina Concurrent', status: 'inactive', lockReason: null },
    },
    {
      label: 'lock while concurrent rename -> 409, fails closed (does not unlock)',
      initial: 'active',
      action: 'lock',
      concurrentWrite: {
        email: 'mina@techrida.test',
        displayName: 'Mina Concurrent',
        status: 'active',
      },
      expectedCalls: ['lock', 'getUser'],
      expectedZitadel: { status: 'inactive', locked: true },
      expectedRow: { displayName: 'Mina Concurrent', status: 'inactive', lockReason: 'admin' },
    },
  ])(
    '$label',
    async ({
      initial,
      lock,
      action,
      concurrentWrite,
      expectedCalls,
      expectedZitadel,
      expectedRow,
    }) => {
      const f = await fixture(initial, { lock });
      const zitadel = new RecordingZitadel();
      zitadel.users.set(
        f.zitadelUserId,
        zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: initial, locked: Boolean(lock) }),
      );
      let mutated = false;
      zitadel.onCall = async (op) => {
        if (mutated || op === 'getUser') return;
        mutated = true;
        await write(f, concurrentWrite);
      };
      const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

      const error = await statusService
        .apply(f.scope, adminActor(f.adminId), f.userId, action)
        .catch((e: unknown) => e);

      expect(error).toBeInstanceOf(ConflictException);
      expect((error as ConflictException).getResponse()).toMatchObject({ code: 'conflict' });
      expect(zitadel.calls).toEqual(expectedCalls.map((c) => `${c}:${f.zitadelUserId}`));
      expect(zitadel.users.get(f.zitadelUserId)).toMatchObject(expectedZitadel);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        ...expectedRow,
        identityReviewRequired: true,
      });
    },
    60_000,
  );

  it('upgrades a failed_sign_ins lock written by sync during phase B to an admin lock instead of 409 + undo', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'active', locked: false }),
    );
    let synced = false;
    zitadel.onCall = async (op) => {
      if (synced || op !== 'lock') return;
      synced = true;
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: {
          reason: 'failed_sign_ins',
          lockedAt: new Date(Date.now() - 10_000),
          until: new Date(Date.now() + 600_000),
        },
      });
    };
    const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

    await statusService.apply(f.scope, adminActor(f.adminId), f.userId, 'lock');

    expect(zitadel.calls).toEqual([`lock:${f.zitadelUserId}`]);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });
    const { rows } = await adminPool.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = 'users.locked'`,
      [f.userId],
    );
    expect(rows).toEqual([{ actor_id: f.adminId }]);
  }, 60_000);

  it('writes an audit row under the admin actor when phase C hits the early alreadyMatchesOutcome return', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'active', locked: false }),
    );
    let raced = false;
    zitadel.onCall = async (op) => {
      if (raced || op !== 'deactivate') return;
      raced = true;
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
      });
    };
    const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

    await statusService.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate');

    const { rows } = await adminPool.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = 'users.deactivated'`,
      [f.userId],
    );
    expect(rows).toEqual([{ actor_id: f.adminId }]);
  }, 60_000);

  it('deactivate of a locked user never reactivates on phase C failure even when lock and re-deactivate both fail (FU1 round-2 B)', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'inactive', locked: true }),
    );
    const warnLog = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const realDeactivate = zitadel.deactivateUser.bind(zitadel);
    let deactivateCalls = 0;
    vi.spyOn(zitadel, 'deactivateUser').mockImplementation((id: string) => {
      deactivateCalls += 1;
      if (deactivateCalls === 1) return realDeactivate(id);
      return Promise.reject(new Error('re-deactivate boom'));
    });
    const lockSpy = vi.spyOn(zitadel, 'lockUser').mockRejectedValue(new Error('relock boom'));
    const failingAudit = {
      record: vi.fn(() => Promise.reject(new Error('audit write boom'))),
    } as unknown as AuditService;
    const statusService = new UserStatusService(db, store, zitadel.asClient(), failingAudit);

    await expect(
      statusService.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
    ).rejects.toThrow('audit write boom');

    expect(lockSpy).toHaveBeenCalled(); // the one best-effort close; it failed and the row is the safe state
    expect(zitadel.calls.filter((c) => !c.startsWith('getUser'))).toEqual([
      `unlock:${f.zitadelUserId}`,
      `deactivate:${f.zitadelUserId}`,
    ]);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: false });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
    expect(warnLog).not.toHaveBeenCalledWith(expect.stringContaining('reactivate'));
  }, 60_000);

  it('deactivate of a locked user retries lockUser when deactivate fails after unlock in phase B so ZITADEL never ends active (FU1 round-2 B)', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status: 'inactive', locked: true }),
    );
    vi.spyOn(zitadel, 'deactivateUser').mockRejectedValueOnce(new Error('ZITADEL 503'));
    const realLock = zitadel.lockUser.bind(zitadel);
    let lockAttempts = 0;
    vi.spyOn(zitadel, 'lockUser').mockImplementation((id: string) => {
      lockAttempts += 1;
      if (lockAttempts < 3) return Promise.reject(new Error('transient relock 503'));
      return realLock(id);
    });
    const statusService = new UserStatusService(db, store, zitadel.asClient(), audit);

    const error = await statusService
      .apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ServiceUnavailableException);
    expect(lockAttempts).toBe(3);
    expect(zitadel.calls.filter((c) => !c.startsWith('getUser'))).toEqual([
      `unlock:${f.zitadelUserId}`,
      `lock:${f.zitadelUserId}`,
    ]);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);

  it('closes ZITADEL again when sync copies unlock/reactivate before phase C fails via a revoked grant (FU1 round-2 A)', async () => {
    // 1. unlock: sync mirrors active/no lock -> revoked grant throws 403 in phase C -> lockUser closes ZITADEL.
    const f1 = await fixture('inactive', { lock: adminLock() });
    const z1 = new RecordingZitadel();
    z1.users.set(
      f1.zitadelUserId,
      zUser(f1.zitadelUserId, { orgId: f1.zitadelOrgId, status: 'inactive', locked: true }),
    );
    let revoked1 = false;
    z1.onCall = async (op) => {
      if (op !== 'unlock' || revoked1) return;
      await write(f1, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'active',
        lock: null,
      });
      revoked1 = true;
    };
    const s1 = new UserStatusService(db, store, z1.asClient(), audit);
    const e1 = await s1
      .apply(f1.scope, adminActor(f1.adminId), f1.userId, 'unlock', () =>
        revoked1 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ForbiddenException);
    expect(z1.calls).toEqual([`unlock:${f1.zitadelUserId}`, `lock:${f1.zitadelUserId}`]);
    expect(z1.users.get(f1.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });

    // 2. unlock with refused lockUser -> falls back to deactivateUser to fail closed.
    const f2 = await fixture('inactive', { lock: adminLock() });
    const z2 = new RecordingZitadel();
    z2.users.set(
      f2.zitadelUserId,
      zUser(f2.zitadelUserId, { orgId: f2.zitadelOrgId, status: 'inactive', locked: true }),
    );
    let revoked2 = false;
    z2.onCall = async (op) => {
      if (op !== 'unlock' || revoked2) return;
      await write(f2, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'active',
        lock: null,
      });
      revoked2 = true;
    };
    vi.spyOn(z2, 'lockUser').mockRejectedValueOnce(
      new ZitadelHttpError('/LockUser', 400, 'failed_precondition'),
    );
    const s2 = new UserStatusService(db, store, z2.asClient(), audit);
    const e2 = await s2
      .apply(f2.scope, adminActor(f2.adminId), f2.userId, 'unlock', () =>
        revoked2 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ForbiddenException);
    expect(z2.calls).toEqual([
      `unlock:${f2.zitadelUserId}`,
      `getUser:${f2.zitadelUserId}`,
      `deactivate:${f2.zitadelUserId}`,
    ]);
    expect(z2.users.get(f2.zitadelUserId)).toMatchObject({ status: 'inactive', locked: false });

    // 3. reactivate: sync mirrors active -> revoked grant throws 403 in phase C -> deactivateUser closes ZITADEL.
    const f3 = await fixture('inactive');
    const z3 = new RecordingZitadel();
    z3.users.set(
      f3.zitadelUserId,
      zUser(f3.zitadelUserId, { orgId: f3.zitadelOrgId, status: 'inactive', locked: false }),
    );
    let revoked3 = false;
    z3.onCall = async (op) => {
      if (op !== 'reactivate' || revoked3) return;
      await write(f3, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'active',
      });
      revoked3 = true;
    };
    const s3 = new UserStatusService(db, store, z3.asClient(), audit);
    const e3 = await s3
      .apply(f3.scope, adminActor(f3.adminId), f3.userId, 'reactivate', () =>
        revoked3 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);
    expect(e3).toBeInstanceOf(ForbiddenException);
    expect(z3.calls).toEqual([`reactivate:${f3.zitadelUserId}`, `deactivate:${f3.zitadelUserId}`]);
    expect(z3.users.get(f3.zitadelUserId)).toMatchObject({ status: 'inactive', locked: false });
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

  it('invite keeps the identity and strips nothing when the Phase (C) DB write fails; the person is closed and flagged (round 3)', async () => {
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
      // The close: deactivate is refused for an invited identity, so it is locked instead (best effort).
      `getUser:${zId}`,
      `lock:${zId}`,
    ]);
    // A flagged, role-less row stands in for the failed invite: the person cannot be opened by a sync or a sign-in.
    const row = await store.findByZitadelId(db, zId);
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
  }, 60_000);

  it('invite reuse path (created: false) strips nothing and denies the person, also once the person signed up (round 3)', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);

    // 1. Existing open invite with prior grants ['accountant']; Phase (C) fails while still invited -> restores ['accountant'].
    zitadel.users.set('z-reuse-invited', {
      id: 'z-reuse-invited',
      orgId: f.zitadelOrgId,
      email: 'reuse-invited@techrida.test',
      displayName: 'Reuse Invited',
      status: 'invited',
      createdAt: new Date(),
    });
    zitadel.grants.set('z-reuse-invited', ['accountant']);
    vi.spyOn(store, 'placeMembership').mockRejectedValueOnce(new Error('placement boom'));

    await expect(
      users.invite(
        f.scope,
        adminActor(f.adminId),
        {
          email: 'reuse-invited@techrida.test',
          givenName: 'Reuse',
          familyName: 'Invited',
          roles: ['finance'],
        },
        { departmentId: f.departmentId, level: 'staff' },
      ),
    ).rejects.toThrow('placement boom');

    // No compensation: what phase B wrote stays; the person is denied in BOS.
    expect(zitadel.grants.get('z-reuse-invited')).toEqual(['finance']);
    const invitedRow = await store.findByZitadelId(db, 'z-reuse-invited');
    expect(invitedRow).toMatchObject({ identityReviewRequired: true });
    expect(invitedRow!.status).not.toBe('active');
    expect(zitadel.users.has('z-reuse-invited')).toBe(true);
    expect(zitadel.calls).not.toContain('deleteUser:z-reuse-invited');

    // 2. Existing open invite where the person finishes sign-up before Phase (C) fails -> must NOT wipe grants.
    zitadel.calls = [];
    zitadel.users.set('z-reuse-active', {
      id: 'z-reuse-active',
      orgId: f.zitadelOrgId,
      email: 'reuse-active@techrida.test',
      displayName: 'Reuse Active',
      status: 'invited',
      createdAt: new Date(),
    });
    zitadel.grants.set('z-reuse-active', ['accountant']);
    zitadel.onCall = async (op) => {
      if (op !== 'sendInviteCode') return;
      // Person finishes sign-up in ZITADEL and sync mirrors them as active before Phase (C) commits.
      const u = zitadel.users.get('z-reuse-active')!;
      u.status = 'active';
      await withTx(db, f.scope, systemActor('sync'), async (tx) => {
        const uid = await store.insertUser(tx, f.scope, {
          zitadelUserId: 'z-reuse-active',
          idpOrgId: f.idpOrgId,
          email: 'reuse-active@techrida.test',
          displayName: 'Reuse Active',
          status: 'active',
        });
        await store.ensureDefaultMembership(tx, f.scope.tenantId, f.scope.organizationId, uid);
      });
    };
    const conflict = await users
      .invite(
        f.scope,
        adminActor(f.adminId),
        {
          email: 'reuse-active@techrida.test',
          givenName: 'Reuse',
          familyName: 'Active',
          roles: ['sales'],
        },
        { departmentId: f.departmentId, level: 'staff' },
      )
      .catch((e: unknown) => e);

    expect(conflict).toBeInstanceOf(ConflictException);
    // No replay into ZITADEL; the signed-up person is closed and flagged in BOS until an admin resolves it.
    expect(zitadel.grants.get('z-reuse-active')).toEqual(['sales']);
    expect(zitadel.calls.filter((c) => c.startsWith('setGrants:'))).toEqual([
      'setGrants:sales:z-reuse-active',
    ]);
    const activeRow = await store.findByZitadelId(db, 'z-reuse-active');
    expect(activeRow).toMatchObject({ identityReviewRequired: true });
    expect(activeRow!.status).not.toBe('active');
    expect(zitadel.calls).not.toContain('deleteUser:z-reuse-active');
  }, 60_000);

  it('setRoles holds no tx or tenant audit lock during setGrants, and denies the person on a concurrent change or DB failure without compensating (round 3)', async () => {
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

    // 2. Concurrent role change committed while setGrants was in flight -> 409 conflict + ZITADEL and DB AGREE on committed roles.
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
    // Nothing is replayed (no strip, no re-grant): the role another admin set stays in the row, and the person is
    // denied in BOS until an admin resolves the flag.
    expect(zitadel.calls.filter((c) => c.startsWith('setGrants:'))).toEqual([
      `setGrants:management:${f.zitadelUserId}`,
    ]);
    expect(await store.rolesOf(db, f.scope.tenantId, f.userId)).toEqual(['sales']);
    const flagged = await store.findById(db, f.scope, f.userId);
    expect(flagged).toMatchObject({ identityReviewRequired: true });
    expect(flagged!.status).not.toBe('active');

    // 3. DB write failure in Phase (C): nothing is replayed; the person is flagged again.
    await withTx(db, f.scope, systemActor('seed'), async (tx) => {
      await store.clearIdentityReview(tx, f.userId);
      await store.replaceRoles(tx, f.scope, f.userId, ['sales']);
    });
    zitadel.grants.set(f.zitadelUserId, ['sales']);
    zitadel.calls = [];
    zitadel.onCall = null;
    vi.spyOn(store, 'replaceRoles').mockRejectedValueOnce(new Error('roles write boom'));
    await expect(
      users.setRoles(f.scope, adminActor(f.adminId), f.userId, ['finance']),
    ).rejects.toThrow('roles write boom');
    expect(zitadel.calls.filter((c) => c.startsWith('setGrants:'))).toEqual([
      `setGrants:finance:${f.zitadelUserId}`,
    ]);
    expect(zitadel.grants.get(f.zitadelUserId)).toEqual(['finance']);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      identityReviewRequired: true,
    });
  }, 60_000);

  it('setRoles strips and re-adds nothing when sync copies phase-B grants before phase C fails via a revoked grant; the person is denied (round 3)', async () => {
    // 1. Added role: ['accountant'] -> ['accountant', 'founder'], sync mirrors it, revoked grant fails phase C -> ZITADEL restored to ['accountant'].
    const f1 = await fixture('active', { roles: ['accountant'] });
    const z1 = new RecordingZitadel();
    z1.users.set(f1.zitadelUserId, zUser(f1.zitadelUserId, { orgId: f1.zitadelOrgId }));
    z1.grants.set(f1.zitadelUserId, ['accountant']);
    const { users: u1 } = services(z1);
    let revoked1 = false;
    z1.onCall = async (op) => {
      if (!op.startsWith('setGrants:') || revoked1) return;
      await withTx(db, f1.scope, systemActor('sync'), (tx) =>
        store.replaceRoles(tx, f1.scope, f1.userId, ['accountant', 'founder']),
      );
      revoked1 = true;
    };
    const e1 = await u1
      .setRoles(f1.scope, adminActor(f1.adminId), f1.userId, ['accountant', 'founder'], () =>
        revoked1 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(ForbiddenException);
    expect(z1.calls.filter((c) => c.startsWith('setGrants:'))).toEqual([
      `setGrants:accountant,founder:${f1.zitadelUserId}`,
    ]);
    expect(z1.grants.get(f1.zitadelUserId)).toEqual(['accountant', 'founder']);
    expect(await store.findById(db, f1.scope, f1.userId)).toMatchObject({
      identityReviewRequired: true,
    });

    // 2. Replace (add + remove): ['accountant'] -> ['founder'], sync mirrors it, revoked grant fails phase C -> ZITADEL gets [] (fail closed, never re-adds 'accountant').
    const f2 = await fixture('active', { roles: ['accountant'] });
    const z2 = new RecordingZitadel();
    z2.users.set(f2.zitadelUserId, zUser(f2.zitadelUserId, { orgId: f2.zitadelOrgId }));
    z2.grants.set(f2.zitadelUserId, ['accountant']);
    const { users: u2 } = services(z2);
    let revoked2 = false;
    z2.onCall = async (op) => {
      if (!op.startsWith('setGrants:') || revoked2) return;
      await withTx(db, f2.scope, systemActor('sync'), (tx) =>
        store.replaceRoles(tx, f2.scope, f2.userId, ['founder']),
      );
      revoked2 = true;
    };
    const e2 = await u2
      .setRoles(f2.scope, adminActor(f2.adminId), f2.userId, ['founder'], () =>
        revoked2 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(ForbiddenException);
    expect(z2.calls.filter((c) => c.startsWith('setGrants:'))).toEqual([
      `setGrants:founder:${f2.zitadelUserId}`,
    ]);
    expect(z2.grants.get(f2.zitadelUserId)).toEqual(['founder']);
    expect(await store.findById(db, f2.scope, f2.userId)).toMatchObject({
      identityReviewRequired: true,
    });
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

// FU8: after a failed or conflicting write nothing replays a snapshot into ZITADEL. The row and ZITADEL are read as
// they are now and the closing state wins; an undo never unlocks, reactivates, adds a role or deletes an identity.
describe('Fail-closed reconcile against Postgres (FU8)', () => {
  const zitadelFor = (f: Fixture, status: 'active' | 'inactive', locked = false) => {
    const zitadel = new RecordingZitadel();
    zitadel.users.set(
      f.zitadelUserId,
      zUser(f.zitadelUserId, { orgId: f.zitadelOrgId, status, locked }),
    );
    return zitadel;
  };
  const services = (zitadel: RecordingZitadel) => {
    const mirror = new UserMirror(
      db,
      store,
      zitadel.asClient(),
      fakeQueue() as unknown as Queue<UsersSyncData>,
    );
    return { mirror, users: new UsersService(mirror, store, zitadel.asClient(), db, audit) };
  };
  const reconciledAudits = async (entityId: string) =>
    (
      await adminPool.query<{ actor_id: string }>(
        `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = 'identity.reconciled'`,
        [entityId],
      )
    ).rows;

  it('race 1: two Founders deactivating each other at once leave exactly one active, in the row and in ZITADEL', async () => {
    const f = await fixture('active', { roles: ['founder'] });
    const adminZ = `admin-${f.scope.tenantId}`;
    const zitadel = zitadelFor(f, 'active');
    zitadel.users.set(adminZ, zUser(adminZ, { orgId: f.zitadelOrgId, status: 'active' }));
    const rowOf = (zId: string) => (zId === adminZ ? f.adminId : f.userId);
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);
    // A webhook sync copies each deactivation into the row as soon as ZITADEL has it, so phase C of the second
    // request would see "already done" and skip its guard. Both requests are already in phase B by then.
    zitadel.onCall = async (op, zId) => {
      if (!op.startsWith('deactivate') || !zId) return;
      await sleep(400);
      zitadel.users.get(zId)!.status = 'inactive';
      await write(
        { ...f, userId: rowOf(zId) },
        { email: `${zId}@techrida.test`, displayName: zId, status: 'inactive' },
      );
    };

    const settled = await Promise.allSettled([
      status.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
      status.apply(f.scope, adminActor(f.userId), f.adminId, 'deactivate'),
    ]);

    expect(settled.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = settled.find((r): r is PromiseRejectedResult => r.status === 'rejected')!;
    expect(lost.reason).toBeInstanceOf(ConflictException);
    const rows = [
      await store.findById(db, f.scope, f.adminId),
      await store.findById(db, f.scope, f.userId),
    ];
    expect(rows.filter((r) => r?.status === 'active')).toHaveLength(1);
    const survivorZ = rows[0]?.status === 'active' ? adminZ : f.zitadelUserId;
    expect(zitadel.users.get(survivorZ)).toMatchObject({ status: 'active' });
    expect(zitadel.calls.filter((c) => c.startsWith('reactivate'))).toEqual([]);
  }, 60_000);

  it('race 2: an unlock the sync copied and phase C rejected ends closed in the row and in ZITADEL, audited, never reopened', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = zitadelFor(f, 'inactive', true);
    let revoked = false;
    zitadel.onCall = async (op) => {
      if (op !== 'unlock' || revoked) return;
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'active',
        lock: null,
      });
      revoked = true;
    };
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    const error = await status
      .apply(f.scope, adminActor(f.adminId), f.userId, 'unlock', () =>
        revoked ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
    expect(zitadel.calls.filter((c) => c.startsWith('unlock'))).toEqual([
      `unlock:${f.zitadelUserId}`,
    ]);
    expect(await reconciledAudits(f.userId)).toEqual([{ actor_id: 'system:identity-reconcile' }]);
  }, 60_000);

  it('race 3: a reused invite that gained Founder and was rejected after the person signed up leaves the person denied in BOS and replays nothing', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);
    zitadel.users.set('z-reuse-founder', {
      id: 'z-reuse-founder',
      orgId: f.zitadelOrgId,
      email: 'reuse-founder@techrida.test',
      displayName: 'Reuse Founder',
      status: 'invited',
      createdAt: new Date(),
    });
    zitadel.grants.set('z-reuse-founder', ['accountant']);
    zitadel.onCall = async (op) => {
      if (op !== 'sendInviteCode') return;
      // The person finishes sign-up and the sync mirrors them as active before phase C commits.
      zitadel.users.get('z-reuse-founder')!.status = 'active';
      await withTx(db, f.scope, systemActor('sync'), async (tx) => {
        const uid = await store.insertUser(tx, f.scope, {
          zitadelUserId: 'z-reuse-founder',
          idpOrgId: f.idpOrgId,
          email: 'reuse-founder@techrida.test',
          displayName: 'Reuse Founder',
          status: 'active',
        });
        await store.ensureDefaultMembership(tx, f.scope.tenantId, f.scope.organizationId, uid);
      });
    };

    const error = await users
      .invite(f.scope, adminActor(f.adminId), {
        email: 'reuse-founder@techrida.test',
        givenName: 'Reuse',
        familyName: 'Founder',
        roles: ['founder'],
      })
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    // No strip: the grant stays in ZITADEL, but the person is closed and flagged in BOS until an admin resolves it.
    expect(zitadel.calls.filter((c) => c.startsWith('setGrants:'))).toHaveLength(1);
    const row = await store.findByZitadelId(db, 'z-reuse-founder');
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
    expect(zitadel.calls.filter((c) => c.startsWith('deleteUser'))).toEqual([]);
  }, 60_000);

  it('race 4: a failed invite never deletes the identity a concurrent invite of the same email just committed', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);
    const input = {
      email: 'twin@techrida.test',
      givenName: 'Twin',
      familyName: 'Invite',
      roles: ['sales' as RoleKey],
    };
    let secondDone = false;
    let started = false;
    zitadel.onCall = async (op) => {
      if (op !== 'sendInviteCode' || started) return;
      started = true;
      // The first invite is between ZITADEL and its write: another writer commits a row for the same identity (a
      // second invite cannot run here, the tenant lease holds it back).
      await withTx(db, f.scope, systemActor('sync'), async (tx) => {
        const uid = await store.insertUser(tx, f.scope, {
          zitadelUserId: `z-new-${f.zitadelOrgId}-1`,
          idpOrgId: f.idpOrgId,
          email: input.email,
          displayName: 'Twin Invite',
          status: 'invited',
        });
        await store.ensureDefaultMembership(tx, f.scope.tenantId, f.scope.organizationId, uid);
      });
      secondDone = true;
    };

    const error = await users
      .invite(f.scope, adminActor(f.adminId), input, null, () =>
        secondDone ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    const zId = `z-new-${f.zitadelOrgId}-1`;
    expect(zitadel.calls.filter((c) => c.startsWith('deleteUser'))).toEqual([]);
    expect(zitadel.users.has(zId)).toBe(true);
    expect(zitadel.grants.get(zId)).toEqual(['sales']);
    expect(await store.findByZitadelId(db, zId)).toMatchObject({ status: 'invited' });
  }, 60_000);

  it('race 5: a failed role change never writes back a role another admin just revoked', async () => {
    const f = await fixture('active', { roles: ['accountant', 'finance'] });
    const zitadel = zitadelFor(f, 'active');
    zitadel.grants.set(f.zitadelUserId, ['accountant', 'finance']);
    const { users } = services(zitadel);
    // Phase C of this request: another admin's phase B has revoked finance in ZITADEL (their phase C has not
    // committed), then this request is rejected.
    const rejected = () => {
      zitadel.grants.set(f.zitadelUserId, ['accountant']);
      return Promise.reject(new ForbiddenException('revoked'));
    };
    let calls = 0;
    const assertAccess = () => (++calls === 1 ? Promise.resolve() : rejected());

    const error = await users
      .setRoles(
        f.scope,
        adminActor(f.adminId),
        f.userId,
        ['accountant', 'finance', 'sales'],
        assertAccess,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.grants.get(f.zitadelUserId)).toEqual(['accountant']);
  }, 60_000);

  it('a failed role change whose database read also fails still never re-adds a revoked role (fail closed, no snapshot)', async () => {
    const f = await fixture('active', { roles: ['accountant', 'finance'] });
    const zitadel = zitadelFor(f, 'active');
    zitadel.grants.set(f.zitadelUserId, ['accountant', 'finance']);
    const { users } = services(zitadel);
    let failing = false;
    const rejected = () => {
      zitadel.grants.set(f.zitadelUserId, ['accountant']);
      failing = true;
      return Promise.reject(new ForbiddenException('revoked'));
    };
    let calls = 0;
    const assertAccess = () => (++calls === 1 ? Promise.resolve() : rejected());
    const findByZitadelId = store.findByZitadelId.bind(store);
    const findById = store.findById.bind(store);
    vi.spyOn(store, 'findByZitadelId').mockImplementation((...a) =>
      failing ? Promise.reject(new Error('db read boom')) : findByZitadelId(...a),
    );
    vi.spyOn(store, 'findById').mockImplementation((...a) =>
      failing ? Promise.reject(new Error('db read boom')) : findById(...a),
    );

    const error = await users
      .setRoles(
        f.scope,
        adminActor(f.adminId),
        f.userId,
        ['accountant', 'finance', 'sales'],
        assertAccess,
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.grants.get(f.zitadelUserId)).toEqual(['accountant']);
  }, 60_000);

  it('a failed invite keeps the identity and its grants and flags the person; a retry of the same invite reuses it and the person stays closed', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);
    vi.spyOn(store, 'placeMembership').mockRejectedValueOnce(new Error('placement boom'));
    const input = {
      email: 'retry@techrida.test',
      givenName: 'Re',
      familyName: 'Try',
      roles: ['sales' as RoleKey],
    };

    await expect(
      users.invite(f.scope, adminActor(f.adminId), input, {
        departmentId: f.departmentId,
        level: 'staff',
      }),
    ).rejects.toThrow('placement boom');

    const zId = `z-new-${f.zitadelOrgId}-1`;
    expect(zitadel.users.get(zId)).toMatchObject({ status: 'inactive', locked: true });
    expect(zitadel.grants.get(zId)).toEqual(['sales']);
    // An admin puts the identity back as an open invite in the console; the retry then reuses it.
    Object.assign(zitadel.users.get(zId)!, { status: 'invited', locked: false });
    expect(zitadel.calls.filter((c) => c.startsWith('deleteUser'))).toEqual([]);
    expect(await store.findByZitadelId(db, zId)).toMatchObject({ identityReviewRequired: true });

    const retried = await users.invite(f.scope, adminActor(f.adminId), input);
    expect(retried).toMatchObject({ zitadelUserId: zId, created: false });
    expect(zitadel.grants.get(zId)).toEqual(['sales']);
    const after = await store.findByZitadelId(db, zId);
    expect(after).toMatchObject({ identityReviewRequired: true });
    expect(after!.status).not.toBe('active');
  }, 60_000);

  it('deactivate of a locked person whose deactivate fails after the unlock locks them again and never ends active', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = zitadelFor(f, 'inactive', true);
    vi.spyOn(zitadel, 'deactivateUser').mockRejectedValue(new Error('ZITADEL 503'));
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    await expect(
      status.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
    expect(zitadel.calls.filter((c) => c.startsWith('reactivate'))).toEqual([]);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ lockReason: 'admin' });
  }, 60_000);

  it('a deactivate of a locked person whose unlock a sync copied and whose deactivate then fails ends closed in the row and in ZITADEL', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = zitadelFor(f, 'inactive', true);
    vi.spyOn(zitadel, 'deactivateUser').mockRejectedValue(new Error('ZITADEL 503'));
    zitadel.onCall = async (op) => {
      if (op !== 'unlock') return;
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'active',
        lock: null,
      });
    };
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    await expect(
      status.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);

  it('a deactivate that went through but whose phase C failed while ZITADEL is unreadable still closes the row', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    vi.spyOn(zitadel, 'getUser').mockRejectedValue(new Error('ZITADEL 503'));
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);
    let checks = 0;

    const error = await status
      .apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate', () =>
        ++checks > 1 ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive' });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: null,
    });
  }, 60_000);

  it('an admin lock whose phase C failed after a sync recorded it as a timed lock becomes an admin lock', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    let synced = false;
    zitadel.onCall = async (op) => {
      if (op !== 'lock' || synced) return;
      synced = true;
      await write(f, {
        email: 'mina@techrida.test',
        displayName: 'Mina Gurung',
        status: 'inactive',
        lock: {
          reason: 'failed_sign_ins',
          lockedAt: new Date(),
          until: new Date(Date.now() + 3_600_000),
        },
      });
    };
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    const error = await status
      .apply(f.scope, adminActor(f.adminId), f.userId, 'lock', () =>
        synced ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ForbiddenException);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      lockReason: 'admin',
    });
  }, 60_000);

  it('a deactivate that timed out after ZITADEL applied it closes the row, so a queued second deactivate cannot take the other Founder', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    const real = zitadel.deactivateUser.bind(zitadel);
    vi.spyOn(zitadel, 'deactivateUser').mockImplementation(async (id: string) => {
      await real(id);
      throw new Error('timed out');
    });
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    await expect(
      status.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate'),
    ).rejects.toBeDefined();

    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive' });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'inactive' });
  }, 60_000);

  it('a sync that tries to reopen the row between the local flag and the ZITADEL close cannot: the flagged row stays closed', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = zitadelFor(f, 'inactive', true);
    const open = {
      email: 'mina@techrida.test',
      displayName: 'Mina Gurung',
      status: 'active' as const,
      lock: null,
    };
    let revoked = false;
    zitadel.onCall = async (op) => {
      if (op === 'unlock' && !revoked) {
        await write(f, open);
        revoked = true;
      }
      if (op === 'lock') await write(f, open);
    };
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);

    await status
      .apply(f.scope, adminActor(f.adminId), f.userId, 'unlock', () =>
        revoked ? Promise.reject(new ForbiddenException('revoked')) : Promise.resolve(),
      )
      .catch(() => undefined);

    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      identityReviewRequired: true,
    });
  }, 60_000);

  /** A deactivate whose ZITADEL call applied but timed out: the person ends closed and flagged. */
  const timedOutDeactivate = async (f: Fixture, zitadel: RecordingZitadel) => {
    const real = zitadel.deactivateUser.bind(zitadel);
    vi.spyOn(zitadel, 'deactivateUser').mockImplementationOnce(async (id: string) => {
      await real(id);
      throw new Error('timed out');
    });
    const status = new UserStatusService(db, store, zitadel.asClient(), audit);
    await status
      .apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate')
      .catch(() => undefined);
    return status;
  };

  it('a deactivate that timed out after ZITADEL applied it leaves the person closed and flagged', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    await timedOutDeactivate(f, zitadel);

    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      status: 'inactive',
      identityReviewRequired: true,
    });
  }, 60_000);

  it('a delayed sync or sign-in after the denial cannot reopen a flagged person, even with ZITADEL active', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    const { mirror } = services(zitadel);
    const status = await timedOutDeactivate(f, zitadel);

    // The console (or a stale read) shows the person active again, and the delayed sync arrives after settlement.
    zitadel.users.get(f.zitadelUserId)!.status = 'active';
    await mirror.syncUser(f.zitadelUserId);
    const afterSync = await store.findById(db, f.scope, f.userId);
    expect(afterSync).toMatchObject({ identityReviewRequired: true });
    expect(afterSync!.status).not.toBe('active');

    // A sign-in resolve (JIT) does not open it either.
    const resolved = await mirror.resolve({
      zitadelUserId: f.zitadelUserId,
      tenantId: f.scope.tenantId,
      idpOrgId: f.idpOrgId,
    });
    expect(resolved.status).not.toBe('active');

    // Unlock and reactivate are refused for a flagged person until an admin resolves it.
    for (const action of ['unlock', 'reactivate'] as const) {
      const error = await status
        .apply(f.scope, adminActor(f.adminId), f.userId, action)
        .catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConflictException);
      // A closed person is refused for unlock as the wrong status, for reactivate as awaiting review.
      expect(['wrong_status', 'identity_review_required']).toContain(
        (error as ConflictException).getResponse() &&
          (error as { getResponse(): { code: string } }).getResponse().code,
      );
    }
  }, 60_000);

  it('a failed local flag still attempts the remote close, and the original error is rethrown', async () => {
    const f = await fixture('inactive', { lock: adminLock() });
    const zitadel = zitadelFor(f, 'inactive', true);
    const failingAudit = {
      record: vi.fn(() => Promise.reject(new Error('audit write boom'))),
    } as unknown as AuditService;
    vi.spyOn(store, 'flagIdentityReview').mockRejectedValueOnce(new Error('flag write boom'));
    const status = new UserStatusService(db, store, zitadel.asClient(), failingAudit);

    await expect(status.apply(f.scope, adminActor(f.adminId), f.userId, 'unlock')).rejects.toThrow(
      'audit write boom',
    );

    // The unlock opened ZITADEL, the flag write failed, and the remote close still ran.
    expect(zitadel.calls.filter((c) => !c.startsWith('getUser'))).toEqual([
      `unlock:${f.zitadelUserId}`,
      `lock:${f.zitadelUserId}`,
    ]);
    expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive', locked: true });
  }, 60_000);

  it('a stalled holder keeps the lease for 300 s and is taken over only after that; no mutation starts past the deadline', async () => {
    const f = await fixture('active');
    const tenant = f.scope.tenantId;
    const name = `users.founder-lease:${tenant}`;
    const ageLease = (seconds: number) =>
      adminPool.query(
        `UPDATE ops.sync_cursors SET updated_at = now() - make_interval(secs => $2) WHERE name = $1`,
        [name, seconds],
      );

    expect(await store.claimFounderLease(tenant, 'holder-a', 300, 1000)).toBe(true);
    await ageLease(200);
    expect(await store.claimFounderLease(tenant, 'holder-b', 300, 1000)).toBe(false);
    await ageLease(301);
    expect(await store.claimFounderLease(tenant, 'holder-b', 300, 1000)).toBe(true);
    // The overtaken holder's release no longer frees the lease.
    await store.releaseFounderLease(tenant, 'holder-a');
    const { rows } = await adminPool.query<{ cursor: string }>(
      `SELECT cursor FROM ops.sync_cursors WHERE name = $1`,
      [name],
    );
    expect(rows[0]!.cursor).toBe('holder-b');
    await store.releaseFounderLease(tenant, 'holder-b');

    // The hard deadline: past it, the next provider mutation does not start.
    await expect(
      withFounderRemovalLease(
        store,
        tenant,
        async () => {
          await sleep(40);
          assertWithinOperationDeadline();
        },
        10,
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);
    // ... and the lease was released, so the next operation is not blocked.
    expect(await store.claimFounderLease(tenant, 'holder-c', 300, 1000)).toBe(true);
    await store.releaseFounderLease(tenant, 'holder-c');
  }, 60_000);

  describe('a stalled holder past the lease TTL (outstanding Founder removal)', () => {
    /** Two Founders (Admin, Mina), a non-Founder actor, and ZITADEL holding both Founders active. */
    async function twoFounders() {
      const f = await fixture('active', { roles: ['founder'] });
      const tenant = f.scope.tenantId;
      const opsId = await withTx(db, f.scope, systemActor('test'), async (tx) => {
        const id = await store.insertUser(tx, f.scope, {
          zitadelUserId: `ops-${tenant}`,
          idpOrgId: f.idpOrgId,
          email: 'ops@techrida.test',
          displayName: 'Ops Admin',
          status: 'active',
        });
        await store.ensureDefaultMembership(tx, tenant, f.scope.organizationId, id);
        return id;
      });
      const adminZ = `admin-${tenant}`;
      const zitadel = zitadelFor(f, 'active');
      zitadel.users.set(adminZ, zUser(adminZ, { orgId: f.zitadelOrgId, status: 'active' }));
      const leaseName = `users.founder-lease:${tenant}`;
      const ageLease = (seconds: number) =>
        adminPool.query(
          `UPDATE ops.sync_cursors SET updated_at = now() - make_interval(secs => $2) WHERE name = $1`,
          [leaseName, seconds],
        );
      const leaseCursor = async () =>
        (
          await adminPool.query<{ cursor: string }>(
            `SELECT cursor FROM ops.sync_cursors WHERE name = $1`,
            [leaseName],
          )
        ).rows[0]?.cursor;
      return { f, opsId, adminZ, zitadel, ageLease, leaseCursor };
    }

    it('H1 closed Founder A in ZITADEL and stalled; H2 takes the lease over and is refused removing Founder B; H1 resumes and changes nothing', async () => {
      const { f, opsId, adminZ, zitadel, ageLease, leaseCursor } = await twoFounders();
      let resume!: () => void;
      const stalled = new Promise<void>((r) => {
        resume = r;
      });
      let reached!: () => void;
      const atStall = new Promise<void>((r) => {
        reached = r;
      });
      // ZITADEL applies H1's deactivate of Mina (Founder A); H1 then stalls before its local write.
      zitadel.onCall = async (op, zId) => {
        if (op === 'deactivate' && zId === f.zitadelUserId) {
          reached();
          await stalled;
        }
      };
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      const h1 = status.apply(f.scope, adminActor(opsId), f.userId, 'deactivate').then(
        () => 'done' as const,
        (error: unknown) => error,
      );
      // Fails fast when H1 ends before it reaches the stall.
      await Promise.race([
        atStall,
        h1.then((outcome) => {
          throw new Error(`H1 ended before the stall: ${String(outcome)}`);
        }),
      ]);
      expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive' });
      zitadel.onCall = null;

      // H1 stays stalled past the TTL; H2 takes the lease over and tries to deactivate Admin (Founder B).
      await ageLease(301);
      const refused = await status
        .apply(f.scope, adminActor(opsId), f.adminId, 'deactivate')
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictException);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'last_founder' });
      expect(zitadel.calls).not.toContain(`deactivate:${adminZ}`);
      expect(zitadel.users.get(adminZ)).toMatchObject({ status: 'active' });
      // H2 settled the outstanding removal: Mina is closed and flagged for review, the lease carries nothing.
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        status: 'inactive',
        identityReviewRequired: true,
      });
      expect(await leaseCursor()).toBe('free');

      // H1 resumes: its lease was taken over, so it writes nothing and calls ZITADEL no more.
      const before = zitadel.calls.length;
      resume();
      const outcome = await h1;
      expect(outcome).toBeInstanceOf(ServiceUnavailableException);
      expect(zitadel.calls.slice(before).filter((c) => !c.startsWith('getUser'))).toEqual([]);
      expect(await store.findById(db, f.scope, f.adminId)).toMatchObject({ status: 'active' });
      expect(zitadel.users.get(adminZ)).toMatchObject({ status: 'active' });
    }, 60_000);

    it('a removal whose holder could not write it down passes to the next holder with the lease, also without a TTL takeover', async () => {
      const { f, opsId, adminZ, zitadel, leaseCursor } = await twoFounders();
      // ZITADEL closes Mina but answers 503; the local flag write fails as well, so the removal stays recorded.
      zitadel.onCall = (op, zId) =>
        op === 'deactivate' && zId === f.zitadelUserId
          ? Promise.reject(new ZitadelHttpError('/v2/users/deactivate', 503, 'unavailable'))
          : Promise.resolve();
      vi.spyOn(store, 'flagIdentityReview').mockRejectedValueOnce(new Error('flag write boom'));
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      await expect(
        status.apply(f.scope, adminActor(opsId), f.userId, 'deactivate'),
      ).rejects.toBeInstanceOf(ServiceUnavailableException);
      zitadel.onCall = null;
      expect(zitadel.users.get(f.zitadelUserId)).toMatchObject({ status: 'inactive' });
      // Mina's row still reads active, and the free lease still carries her removal.
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'active' });
      expect(await leaseCursor()).toMatch(/^free\|/);

      const refused = await status
        .apply(f.scope, adminActor(opsId), f.adminId, 'deactivate')
        .catch((e: unknown) => e);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'last_founder' });
      expect(zitadel.calls).not.toContain(`deactivate:${adminZ}`);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        status: 'inactive',
        identityReviewRequired: true,
      });
      expect(await leaseCursor()).toBe('free');
    }, 60_000);

    it('a Founder removal that finishes clears its record: the lease is plain free again', async () => {
      const { f, opsId, zitadel, leaseCursor } = await twoFounders();
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      await status.apply(f.scope, adminActor(opsId), f.userId, 'deactivate');
      expect(await leaseCursor()).toBe('free');
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        status: 'inactive',
        identityReviewRequired: false,
      });
    }, 60_000);

    /** A promise H1's ZITADEL call waits on, and one that resolves once H1 reached it. */
    function stallPoint() {
      let resume!: () => void;
      const stalled = new Promise<void>((r) => {
        resume = r;
      });
      let reached!: () => void;
      const atStall = new Promise<void>((r) => {
        reached = r;
      });
      return { resume, stalled, reached, atStall };
    }
    const reach = (atStall: Promise<void>, h1: Promise<unknown>) =>
      Promise.race([
        atStall,
        h1.then((outcome) => {
          throw new Error(`H1 ended before the stall: ${String(outcome)}`);
        }),
      ]);

    it('an inherited lock that a sync already mirrored as a timed lock is flagged and pinned as an admin lock', async () => {
      const { f, opsId, adminZ, zitadel, ageLease } = await twoFounders();
      zitadel.grants.set(f.zitadelUserId, ['founder']);
      // The lockout policy has been in place for an hour, so a fresh lock reads as a failed-sign-in lock.
      await store.setCursor(
        lockoutPinnedCursor(f.zitadelOrgId),
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      const stall = stallPoint();
      zitadel.onCall = async (op, zId) => {
        if (op === 'lock' && zId === f.zitadelUserId) {
          zitadel.users.get(zId)!.changedAt = new Date();
          stall.reached();
          await stall.stalled;
        }
      };
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      const h1 = status.apply(f.scope, adminActor(opsId), f.userId, 'lock').then(
        () => 'done' as const,
        (error: unknown) => error,
      );
      await reach(stall.atStall, h1);

      // A sync cannot mirror the fresh lock as a timed lock while H1 holds the lease (R6E); once the lease is
      // dead, the sync takes it over, settles H1's removal (the lock is real in ZITADEL, so Mina is flagged) and pins
      // the lock as an admin lock the expiry job never lifts.
      const mirror = new UserMirror(
        db,
        store,
        zitadel.asClient(),
        fakeQueue() as unknown as Queue<UsersSyncData>,
      );
      await ageLease(301);
      await mirror.syncUser(f.zitadelUserId);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        status: 'inactive',
        lockReason: 'admin',
        identityReviewRequired: true,
      });

      const refused = await status
        .apply(f.scope, adminActor(opsId), f.adminId, 'deactivate')
        .catch((e: unknown) => e);
      expect((refused as ConflictException).getResponse()).toMatchObject({ code: 'last_founder' });
      expect(zitadel.calls).not.toContain(`deactivate:${adminZ}`);
      // The takeover flagged Mina and pinned the lock as an admin lock, which never expires.
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        status: 'inactive',
        lockReason: 'admin',
        identityReviewRequired: true,
      });

      stall.resume();
      expect(await h1).toBeInstanceOf(ServiceUnavailableException);
    }, 60_000);

    it('a non-Founder lock fenced out after a takeover is still closed and flagged here, with the admin lock pinned', async () => {
      const { f, opsId, zitadel, ageLease } = await twoFounders();
      const tenant = f.scope.tenantId;
      const opsZ = `ops-${tenant}`;
      zitadel.users.set(opsZ, zUser(opsZ, { orgId: f.zitadelOrgId, status: 'active' }));
      await store.setCursor(
        lockoutPinnedCursor(f.zitadelOrgId),
        new Date(Date.now() - 3_600_000).toISOString(),
      );
      const stall = stallPoint();
      zitadel.onCall = async (op, zId) => {
        if (op === 'lock' && zId === opsZ) {
          zitadel.users.get(zId)!.changedAt = new Date();
          stall.reached();
          await stall.stalled;
        }
      };
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      // H1 locks Ops (no Founder, so nothing is recorded); ZITADEL applies the lock, then H1 stalls.
      const h1 = status.apply(f.scope, adminActor(f.adminId), opsId, 'lock').then(
        () => 'done' as const,
        (error: unknown) => error,
      );
      await reach(stall.atStall, h1);

      // Once the lease is dead, a sync takes it over and mirrors the fresh lock as a timed lock the expiry job would lift.
      const mirror = new UserMirror(
        db,
        store,
        zitadel.asClient(),
        fakeQueue() as unknown as Queue<UsersSyncData>,
      );
      await ageLease(301);
      await mirror.syncUser(opsZ);
      expect(await store.findById(db, f.scope, opsId)).toMatchObject({
        lockReason: 'failed_sign_ins',
      });

      // Another holder takes the lease over and finishes.
      await ageLease(301);
      expect(await store.claimFounderLease(tenant, 'holder-x', 300, 1000)).toBe(true);
      await store.releaseFounderLease(tenant, 'holder-x');

      // H1 resumes: fenced out of its write, it still closes and flags Ops here, and calls ZITADEL no more.
      const before = zitadel.calls.length;
      stall.resume();
      expect(await h1).toBeInstanceOf(ServiceUnavailableException);
      expect(zitadel.calls.slice(before).filter((c) => !c.startsWith('getUser'))).toEqual([]);
      expect(await store.findById(db, f.scope, opsId)).toMatchObject({
        status: 'inactive',
        lockReason: 'admin',
        identityReviewRequired: true,
      });
    }, 60_000);

    it('a stalled role set that granted Founder writes nothing after a takeover, also when the successor is a local no-op', async () => {
      const { f, opsId, zitadel, ageLease } = await twoFounders();
      const opsZ = `ops-${f.scope.tenantId}`;
      const stall = stallPoint();
      zitadel.onCall = async (op, zId) => {
        if (op === 'setGrants:founder' && zId === opsZ) {
          // The double records the call before it applies the grants: apply them now, as ZITADEL already has.
          zitadel.grants.set(opsZ, ['founder']);
          stall.reached();
          await stall.stalled;
        }
      };
      const { mirror } = services(zitadel);
      // H1 grants Founder to Ops (not a Founder, so no removal is recorded); ZITADEL applies it, then H1 stalls.
      const h1 = mirror.setRoles(f.scope, adminActor(f.adminId), opsId, ['founder']).then(
        () => 'done' as const,
        (error: unknown) => error,
      );
      await reach(stall.atStall, h1);
      expect(zitadel.grants.get(opsZ)).toEqual(['founder']);

      // H2 takes the lease over and restores Ops' roles in ZITADEL; the database already holds them.
      await ageLease(301);
      await mirror.setRoles(f.scope, adminActor(f.adminId), opsId, []);
      expect(zitadel.grants.get(opsZ)).toEqual([]);

      // H1 resumes: its lease is gone, so the stale Founder grant never reaches the database.
      stall.resume();
      expect(await h1).toBeInstanceOf(ServiceUnavailableException);
      expect(await store.rolesOf(db, f.scope.tenantId, opsId)).toEqual([]);
      // ... and the person whose grants it may have changed is flagged for review.
      expect(await store.findById(db, f.scope, opsId)).toMatchObject({
        identityReviewRequired: true,
      });
    }, 60_000);

    it('the store carries the record across release and takeover, and a taken-over holder can neither record nor clear', async () => {
      const { f, leaseCursor, ageLease } = await twoFounders();
      const tenant = f.scope.tenantId;
      const removal = { userId: f.userId, zitadelUserId: f.zitadelUserId, intent: 'deactivate' };
      expect(await store.claimFounderLease(tenant, 'holder-a', 300, 1000)).toBe(true);
      expect(await store.recordFounderRemoval(tenant, 'holder-a', removal)).toBe(true);
      await store.releaseFounderLease(tenant, 'holder-a');
      expect(await leaseCursor()).toBe(`free|${JSON.stringify(removal)}`);
      expect(await store.claimFounderLease(tenant, 'holder-b', 300, 1000)).toBe(true);
      expect(await store.outstandingFounderRemoval(tenant, 'holder-b')).toEqual(removal);
      // Past the TTL holder-c takes over with the record; holder-b is fenced out.
      await ageLease(301);
      expect(await store.claimFounderLease(tenant, 'holder-c', 300, 1000)).toBe(true);
      expect(await store.outstandingFounderRemoval(tenant, 'holder-c')).toEqual(removal);
      expect(await store.settleFounderRemoval(tenant, 'holder-b')).toBe(false);
      expect(await store.recordFounderRemoval(tenant, 'holder-b', removal)).toBe(false);
      expect(await store.settleFounderRemoval(tenant, 'holder-c')).toBe(true);
      expect(await leaseCursor()).toBe('holder-c');
      await store.releaseFounderLease(tenant, 'holder-c');
      expect(await leaseCursor()).toBe('free');
    }, 60_000);
  });

  it('two real concurrent invites of one email serialise on the lease: one identity, no delete', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users } = services(zitadel);
    const input = {
      email: 'twin2@techrida.test',
      givenName: 'Twin',
      familyName: 'Two',
      roles: ['sales' as RoleKey],
    };

    const settled = await Promise.allSettled([
      users.invite(f.scope, adminActor(f.adminId), input),
      users.invite(f.scope, adminActor(f.adminId), input),
    ]);

    expect(settled.filter((r) => r.status === 'rejected')).toEqual([]);
    // Exactly one identity was created; the second invite found it (its create attempt is refused as a duplicate).
    const created = settled.map(
      (r) => (r as PromiseFulfilledResult<{ created: boolean }>).value.created,
    );
    expect(created.filter(Boolean)).toHaveLength(1);
    expect(zitadel.calls.filter((c) => c.startsWith('deleteUser'))).toEqual([]);
    const { rows } = await adminPool.query(`SELECT id FROM app.users WHERE email = $1`, [
      input.email,
    ]);
    expect(rows).toHaveLength(1);
  }, 60_000);

  it('an admin resolves a flagged person: ZITADEL is read again, the flag clears, the row follows ZITADEL, audited; 409 when not flagged', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    const { users, mirror } = services(zitadel);
    await timedOutDeactivate(f, zitadel);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
      identityReviewRequired: true,
    });

    await users.resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId);

    // ZITADEL holds the person deactivated, so the synced row is closed and no longer flagged.
    const resolved = await store.findById(db, f.scope, f.userId);
    expect(resolved).toMatchObject({ status: 'inactive' });
    expect(resolved!.identityReviewRequired).toBeFalsy();
    const { rows } = await adminPool.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit.audit_events WHERE entity_id = $1 AND action = 'identity.review_resolved'`,
      [f.userId],
    );
    expect(rows).toEqual([{ actor_id: f.adminId }]);

    const again = await users
      .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
      .catch((e: unknown) => e);
    expect(again).toBeInstanceOf(ConflictException);
    expect((again as ConflictException).getResponse()).toMatchObject({ code: 'wrong_status' });

    // Once resolved, a sync follows ZITADEL again.
    zitadel.users.get(f.zitadelUserId)!.status = 'active';
    await mirror.syncUser(f.zitadelUserId);
    expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'active' });
  }, 60_000);

  it('when the invite write and the denial write both fail, the identity is still deactivated in ZITADEL and a sign-in creates no row (round 4)', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users, mirror } = services(zitadel);
    const insert = vi.spyOn(store, 'insertUser').mockRejectedValue(new Error('db down'));

    await expect(
      users.invite(f.scope, adminActor(f.adminId), {
        email: 'ghost@techrida.test',
        givenName: 'Ghost',
        familyName: 'Invitee',
        roles: ['sales'],
      }),
    ).rejects.toThrow('db down');
    insert.mockRestore();

    const zId = `z-new-${f.zitadelOrgId}-1`;
    expect(zitadel.users.get(zId)).toMatchObject({ status: 'inactive' });
    expect(await store.findByZitadelId(db, zId)).toBeNull();
    // /v1/me (resolve) refuses and creates no row for an invite that never committed.
    await expect(
      mirror.resolve({ zitadelUserId: zId, tenantId: f.scope.tenantId, idpOrgId: f.idpOrgId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await store.findByZitadelId(db, zId)).toBeNull();
  }, 60_000);

  it.each([
    ['getUser', 'getUser'],
    ['listGrants', 'listGrants'],
  ] as const)(
    'resolve answers 503 and leaves the flag set when ZITADEL cannot be read (%s)',
    async (_label, method) => {
      const f = await fixture('active');
      const zitadel = zitadelFor(f, 'active');
      const { users } = services(zitadel);
      await timedOutDeactivate(f, zitadel);
      const spy = vi.spyOn(zitadel, method).mockRejectedValue(new Error('ZITADEL down'));

      const error = await users
        .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
        .catch((e: unknown) => e);
      spy.mockRestore();

      expect(error).toBeInstanceOf(ServiceUnavailableException);
      const row = await store.findById(db, f.scope, f.userId);
      expect(row).toMatchObject({ identityReviewRequired: true });
      expect(row!.status).not.toBe('active');
    },
    60_000,
  );

  it('resolve answers 409 and keeps the flag when the person was flagged again while ZITADEL was read', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    const { users } = services(zitadel);
    await timedOutDeactivate(f, zitadel);
    zitadel.users.get(f.zitadelUserId)!.status = 'active'; // what the read will report
    let flagged = false;
    zitadel.onCall = async (op) => {
      if (op !== 'listGrants' || flagged) return;
      flagged = true;
      await withTx(db, f.scope, systemActor('another-failure'), (tx) =>
        store.flagIdentityReview(tx, f.userId),
      );
    };

    const error = await users
      .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    const row = await store.findById(db, f.scope, f.userId);
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
  }, 60_000);

  it('resolve answers 503 and keeps the flag when the confirmation read of ZITADEL fails (round 5)', async () => {
    const f = await fixture('active');
    const zitadel = zitadelFor(f, 'active');
    const { users } = services(zitadel);
    await timedOutDeactivate(f, zitadel);
    zitadel.users.get(f.zitadelUserId)!.status = 'active'; // differs from the closed row: the status is re-read
    const real = zitadel.getUser.bind(zitadel);
    let reads = 0;
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) =>
      ++reads === 1 ? real(id) : Promise.reject(new Error('ZITADEL down')),
    );

    const error = await users
      .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
      .catch((e: unknown) => e);

    expect(reads).toBeGreaterThan(1);
    expect(error).toBeInstanceOf(ServiceUnavailableException);
    const row = await store.findById(db, f.scope, f.userId);
    expect(row).toMatchObject({ identityReviewRequired: true });
    expect(row!.status).not.toBe('active');
  }, 60_000);

  it('sync and reconcile never admit an invite that never committed, even when the remote close failed (round 5)', async () => {
    const f = await fixture('active');
    const zitadel = new RecordingZitadel();
    const { users, mirror } = services(zitadel);
    const insert = vi.spyOn(store, 'insertUser').mockRejectedValue(new Error('db down'));
    vi.spyOn(zitadel, 'lockUser').mockRejectedValue(new Error('ZITADEL down'));
    vi.spyOn(zitadel, 'deactivateUser').mockRejectedValue(new Error('ZITADEL down'));

    await expect(
      users.invite(f.scope, adminActor(f.adminId), {
        email: 'ghost2@techrida.test',
        givenName: 'Ghost',
        familyName: 'Two',
        roles: ['sales'],
      }),
    ).rejects.toThrow('db down');
    insert.mockRestore();

    // The remote close failed, so ZITADEL reports the person active after they finished the invite.
    const zId = `z-new-${f.zitadelOrgId}-1`;
    zitadel.users.get(zId)!.status = 'active';

    await mirror.syncUser(zId);
    await mirror.reconcile();

    const row = await store.findByZitadelId(db, zId);
    expect(row === null || row.status !== 'active').toBe(true);
    await expect(
      mirror.resolve({ zitadelUserId: zId, tenantId: f.scope.tenantId, idpOrgId: f.idpOrgId }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(await store.findByZitadelId(db, zId)).toBeNull();
  }, 60_000);
  describe('R6E: identity backend (takeover flags, writes under the lease, createHuman without an id)', () => {
    const leaseName = (f: Fixture) => `users.founder-lease:${f.scope.tenantId}`;
    const ageLeaseOf = (f: Fixture, seconds: number) =>
      adminPool.query(
        `UPDATE ops.sync_cursors SET updated_at = now() - make_interval(secs => $2) WHERE name = $1`,
        [leaseName(f), seconds],
      );
    const leaseCursorOf = async (f: Fixture) =>
      (
        await adminPool.query<{ cursor: string }>(
          `SELECT cursor FROM ops.sync_cursors WHERE name = $1`,
          [leaseName(f)],
        )
      ).rows[0]?.cursor;
    /** A holder that recorded removing Mina (a Founder) and died: the lease is past its TTL with the record on it. */
    const deadHolderRemoving = async (f: Fixture, intent: string) => {
      const tenant = f.scope.tenantId;
      expect(await store.claimFounderLease(tenant, 'dead-holder', 300, 1000)).toBe(true);
      expect(
        await store.recordFounderRemoval(tenant, 'dead-holder', {
          userId: f.userId,
          zitadelUserId: f.zitadelUserId,
          intent,
        }),
      ).toBe(true);
      await ageLeaseOf(f, 301);
    };
    const stall = () => {
      let resume!: () => void;
      const stalled = new Promise<void>((r) => {
        resume = r;
      });
      let reached!: () => void;
      const atStall = new Promise<void>((r) => {
        reached = r;
      });
      return { resume, stalled, reached, atStall };
    };

    it('D3: a crash before ZITADEL changed leaves the Founder unflagged when ZITADEL still holds them active', async () => {
      const f = await fixture('active', { roles: ['founder'] });
      const zitadel = zitadelFor(f, 'active');
      await deadHolderRemoving(f, 'deactivate');
      await services(zitadel).mirror.syncUser(f.zitadelUserId); // takes the dead lease over

      const row = await store.findById(db, f.scope, f.userId);
      expect(row).toMatchObject({ status: 'active' });
      expect(row!.identityReviewRequired).toBeFalsy();
      expect(row!.lockReason ?? null).toBeNull();
      expect(await leaseCursorOf(f)).toBe('free');
    }, 60_000);

    it('D3: a crash after ZITADEL closed the Founder still flags them, with the lock pinned', async () => {
      const f = await fixture('active', { roles: ['founder'] });
      const zitadel = zitadelFor(f, 'active', true); // locked in ZITADEL
      await deadHolderRemoving(f, 'lock');
      await services(zitadel).mirror.syncUser(f.zitadelUserId);

      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        identityReviewRequired: true,
        lockReason: 'admin',
      });
      expect(await leaseCursorOf(f)).toBe('free');
    }, 60_000);

    it('D3: a crash with ZITADEL unreadable flags the Founder', async () => {
      const f = await fixture('active', { roles: ['founder'] });
      const zitadel = zitadelFor(f, 'active');
      await deadHolderRemoving(f, 'deactivate');
      let first = true;
      zitadel.onCall = (op) => {
        if (op === 'getUser' && first) {
          first = false;
          return Promise.reject(new Error('ZITADEL 503'));
        }
        return Promise.resolve();
      };
      await services(zitadel).mirror.syncUser(f.zitadelUserId);

      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        identityReviewRequired: true,
      });
    }, 60_000);

    it('D3: a crashed role set leaves the Founder unflagged when ZITADEL still holds the same roles, and flags them when it differs', async () => {
      const same = await fixture('active', { roles: ['founder'] });
      const zSame = zitadelFor(same, 'active');
      zSame.grants.set(same.zitadelUserId, ['founder']);
      await deadHolderRemoving(same, 'set_roles');
      await services(zSame).mirror.syncUser(same.zitadelUserId);
      const sameRow = await store.findById(db, same.scope, same.userId);
      expect(sameRow!.identityReviewRequired).toBeFalsy();

      const differs = await fixture('active', { roles: ['founder'] });
      const zDiffers = zitadelFor(differs, 'active');
      zDiffers.grants.set(differs.zitadelUserId, ['accountant']); // the role set reached ZITADEL
      await deadHolderRemoving(differs, 'set_roles');
      await services(zDiffers).mirror.syncUser(differs.zitadelUserId);
      expect(await store.findById(db, differs.scope, differs.userId)).toMatchObject({
        identityReviewRequired: true,
      });
    }, 60_000);

    it('D4: a resolve waits for the tenant lease and answers 409 while another identity change holds it, reading nothing', async () => {
      const f = await fixture('active');
      const zitadel = zitadelFor(f, 'active');
      const { users } = services(zitadel);
      await timedOutDeactivate(f, zitadel);
      const reads = zitadel.calls.length;
      expect(await store.claimFounderLease(f.scope.tenantId, 'live-holder', 300, 1000)).toBe(true);

      const refused = await users
        .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
        .catch((e: unknown) => e);
      expect(refused).toBeInstanceOf(ConflictException);
      expect(zitadel.calls.length).toBe(reads);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        identityReviewRequired: true,
      });

      await store.releaseFounderLease(f.scope.tenantId, 'live-holder');
      await users.resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId);
      expect((await store.findById(db, f.scope, f.userId))!.identityReviewRequired).toBeFalsy();
    }, 60_000);

    it('D4: a resolve whose lease was taken over while ZITADEL was read writes nothing and keeps the flag (503)', async () => {
      const f = await fixture('active');
      const zitadel = zitadelFor(f, 'active');
      const { users } = services(zitadel);
      await timedOutDeactivate(f, zitadel);
      let taken = false;
      zitadel.onCall = async (op) => {
        if (op === 'getUser' && !taken) {
          taken = true;
          await ageLeaseOf(f, 301);
          expect(await store.claimFounderLease(f.scope.tenantId, 'taker', 300, 1000)).toBe(true);
        }
      };
      const outcome = await users
        .resolveIdentityReview(f.scope, adminActor(f.adminId), f.userId)
        .catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(ServiceUnavailableException);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({
        identityReviewRequired: true,
      });
    }, 60_000);

    it('D4: a sync cannot copy ZITADEL while an admin status action holds the lease; it can once that finishes', async () => {
      const f = await fixture('active');
      const zitadel = zitadelFor(f, 'active');
      const { mirror } = services(zitadel);
      const gate = stall();
      zitadel.onCall = async (op, zId) => {
        if (op === 'deactivate' && zId === f.zitadelUserId) {
          gate.reached();
          await gate.stalled;
        }
      };
      const status = new UserStatusService(db, store, zitadel.asClient(), audit);
      const h1 = status.apply(f.scope, adminActor(f.adminId), f.userId, 'deactivate').then(
        () => 'done' as const,
        (error: unknown) => error,
      );
      await Promise.race([
        gate.atStall,
        h1.then((o) => {
          throw new Error(`H1 ended before the stall: ${String(o)}`);
        }),
      ]);
      // ZITADEL already holds the person deactivated, the row not yet: the sync must not write that state first.
      await expect(mirror.syncUser(f.zitadelUserId)).rejects.toBeInstanceOf(UserSyncContendedError);
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'active' });
      // A reconcile pass leaves the person for the next pass instead of failing.
      await expect(mirror.reconcile()).resolves.toMatchObject({ changed: 0 });
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'active' });

      gate.resume();
      expect(await h1).toBe('done');
      expect(await store.findById(db, f.scope, f.userId)).toMatchObject({ status: 'inactive' });
      await expect(mirror.syncUser(f.zitadelUserId)).resolves.toBeTypeOf('boolean');
    }, 60_000);

    it('D4: an invite whose lease was taken over before its final write leaves only a closed, flagged row with no roles (503)', async () => {
      const f = await fixture('active');
      const zitadel = new RecordingZitadel();
      const { users } = services(zitadel);
      let taken = false;
      zitadel.onCall = async (op) => {
        if (op === 'sendInviteCode' && !taken) {
          taken = true;
          await ageLeaseOf(f, 301);
          expect(await store.claimFounderLease(f.scope.tenantId, 'taker', 300, 1000)).toBe(true);
        }
      };
      const outcome = await users
        .invite(f.scope, adminActor(f.adminId), {
          email: 'late@techrida.test',
          givenName: 'Late',
          familyName: 'Invitee',
          roles: ['sales'],
        })
        .catch((e: unknown) => e);
      expect(outcome).toBeInstanceOf(ServiceUnavailableException);
      const { rows } = await adminPool.query<{ id: string; identity_review_required: boolean }>(
        `SELECT id, identity_review_required FROM app.users WHERE email = $1`,
        ['late@techrida.test'],
      );
      expect(rows.every((r) => r.identity_review_required === true)).toBe(true);
      for (const row of rows) {
        expect(await store.rolesOf(db, f.scope.tenantId, row.id)).toEqual([]);
      }
    }, 60_000);

    describe('createHuman answers with no id', () => {
      const input = {
        email: 'lost@techrida.test',
        givenName: 'Lost',
        familyName: 'Id',
        roles: ['sales' as RoleKey],
      };
      /** ZITADEL makes the person, then the answer is lost (a timeout). */
      const lostAnswer = (zitadel: RecordingZitadel) => {
        const real = zitadel.createHuman.bind(zitadel);
        vi.spyOn(zitadel, 'createHuman').mockImplementationOnce(async (...args) => {
          await real(...args);
          throw new ZitadelHttpError('/v2/users/new', 503, 'unavailable');
        });
      };

      it('finds the identity by email and finishes the invite', async () => {
        const f = await fixture('active');
        const zitadel = new RecordingZitadel();
        lostAnswer(zitadel);
        const { users } = services(zitadel);

        const invited = await users.invite(f.scope, adminActor(f.adminId), input);
        const zId = `z-new-${f.zitadelOrgId}-1`;
        expect(invited).toMatchObject({ zitadelUserId: zId });
        expect(zitadel.grants.get(zId)).toEqual(['sales']);
        expect(await store.findByZitadelId(db, zId)).toMatchObject({ status: 'invited' });
      }, 60_000);

      it('flags the person when a step after the lost answer fails', async () => {
        const f = await fixture('active');
        const zitadel = new RecordingZitadel();
        lostAnswer(zitadel);
        vi.spyOn(zitadel, 'sendInviteCode').mockRejectedValueOnce(
          new ZitadelHttpError('/v2/users/invite', 503, 'unavailable'),
        );
        const { users } = services(zitadel);

        await expect(users.invite(f.scope, adminActor(f.adminId), input)).rejects.toBeInstanceOf(
          ZitadelHttpError,
        );
        const row = await store.findByZitadelId(db, `z-new-${f.zitadelOrgId}-1`);
        expect(row).toMatchObject({ identityReviewRequired: true });
      }, 60_000);

      it('rethrows the original error when ZITADEL shows no such person, and when the lookup fails', async () => {
        const f = await fixture('active');
        const none = new RecordingZitadel();
        vi.spyOn(none, 'createHuman').mockRejectedValueOnce(
          new ZitadelHttpError('/v2/users/new', 503, 'unavailable'),
        );
        await expect(
          services(none).users.invite(f.scope, adminActor(f.adminId), input),
        ).rejects.toMatchObject({ status: 503 });
        expect(
          await adminPool.query(`SELECT 1 FROM app.users WHERE email = $1 AND tenant_id = $2`, [
            input.email,
            f.scope.tenantId,
          ]),
        ).toMatchObject({ rowCount: 0 });

        const blind = new RecordingZitadel();
        lostAnswer(blind);
        vi.spyOn(blind, 'listUsers').mockRejectedValue(new Error('ZITADEL down'));
        await expect(
          services(blind).users.invite(f.scope, adminActor(f.adminId), input),
        ).rejects.toMatchObject({ status: 503 });
      }, 60_000);

      it('a retry of the same invite after an unreadable lookup finds the identity through the open-invite path', async () => {
        const f = await fixture('active');
        const zitadel = new RecordingZitadel();
        lostAnswer(zitadel);
        const list = vi
          .spyOn(zitadel, 'listUsers')
          .mockRejectedValueOnce(new Error('ZITADEL down'));
        const { users } = services(zitadel);
        await expect(users.invite(f.scope, adminActor(f.adminId), input)).rejects.toBeInstanceOf(
          ZitadelHttpError,
        );
        list.mockRestore();
        const retry = await users.invite(f.scope, adminActor(f.adminId), input);
        expect(retry).toMatchObject({ zitadelUserId: `z-new-${f.zitadelOrgId}-1`, created: false });
      }, 60_000);
    });
  });
});
