// Unit tests of the timed sign-in lock's worker half (F1-Q4): the lock-expiry job and the lockout-policy pinning. The
// store and ZITADEL are fakes; the SQL half of expiredLocks and the lock columns is in admin-users.test.ts (Docker).
import { ACCOUNT_LOCKOUT } from '@bos/contracts';
import { Logger } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service';
import type { Db, DbTransaction } from '../db/db.module';
import { UserLocks } from './user-locks';
import { lockoutPinnedCursor } from './users.constants';
import { FakeUsersStore, STAFF_IDP, STAFF_ZORG, TENANT, zUser } from './users.fakes';
import {
  type OrgLockoutPolicy,
  type ZitadelAdminClient,
  ZitadelHttpError,
  ZitadelNotConfiguredError,
  type ZitadelUser,
} from './zitadel-admin.client';

const NOW = new Date('2026-11-20T10:30:00.000Z');
const WINDOW_MS = ACCOUNT_LOCKOUT.lockMinutes * 60_000;
const USER = '00000000-0000-4000-9000-000000000301';
const OTHER = '00000000-0000-4000-9000-000000000302';

/** ZITADEL with users, an unlock that can fail, and a lockout policy per org. */
class LockZitadel {
  users = new Map<string, ZitadelUser>();
  unlockCalls: string[] = [];
  lockCalls: string[] = [];
  lockAttempts = 0;
  failLock: Error | null = null;
  failUnlock: Error | null = null;
  failGetUser: Error | null = null;
  policyCalls: { orgId: string; want: OrgLockoutPolicy }[] = [];
  policyAnswer: 'created' | 'updated' | 'unchanged' | Error = 'created';
  /** Every call made while a transaction was open (there must be none). */
  callsInTx: string[] = [];
  /** Runs inside unlockUser, after ZITADEL unlocked: what happens here while it does. */
  duringUnlock: (() => void) | null = null;

  private called(name: string) {
    if (openTx > 0) this.callsInTx.push(name);
  }
  getUser(id: string) {
    this.called('getUser');
    if (this.failGetUser) return Promise.reject(this.failGetUser);
    return Promise.resolve(this.users.get(id) ?? null);
  }
  unlockUser(id: string) {
    this.called('unlockUser');
    if (this.failUnlock) return Promise.reject(this.failUnlock);
    this.unlockCalls.push(id);
    const user = this.users.get(id);
    if (user) Object.assign(user, { status: 'active', locked: false });
    this.duringUnlock?.();
    return Promise.resolve();
  }
  lockUser(id: string) {
    this.called('lockUser');
    this.lockAttempts += 1;
    if (this.failLock) return Promise.reject(this.failLock);
    this.lockCalls.push(id);
    const user = this.users.get(id);
    if (user) Object.assign(user, { status: 'inactive', locked: true });
    return Promise.resolve();
  }
  ensureOrgLockoutPolicy(orgId: string, want: OrgLockoutPolicy) {
    this.policyCalls.push({ orgId, want });
    const answer = this.policyAnswer;
    return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
  }
}

let store: FakeUsersStore;
let zitadel: LockZitadel;
let audit: { record: ReturnType<typeof vi.fn> };
/** The bos.actor_id each transaction set, in order. */
let actors: string[];
/** Transactions open right now. */
let openTx: number;
/** When set, the next transaction commits (keeps its writes) and then rejects with this error. */
let failCommit: Error | null;
let locks: UserLocks;

function recordingDb(): Db {
  const tx = {
    execute(query: SQL) {
      // sql`` keeps each interpolated value as a chunk of its own.
      const actor = query.queryChunks.find(
        (chunk): chunk is string => typeof chunk === 'string' && chunk.startsWith('system:'),
      );
      if (actor) actors.push(actor);
      return Promise.resolve({ rows: [] });
    },
  } as unknown as DbTransaction;
  return {
    async transaction<T>(fn: (t: DbTransaction) => Promise<T>) {
      openTx += 1;
      const usersBefore = store.users.map((u) => ({ ...u }));
      const bumpsBefore = store.authzBumps;
      const updatesBefore = store.updates.length;
      const cursorsBefore = new Map(store.cursors);
      let committed = false;
      try {
        const result = await fn(tx);
        committed = true;
        if (failCommit) {
          const error = failCommit;
          failCommit = null;
          throw error;
        }
        return result;
      } catch (error) {
        if (!committed) {
          store.users = usersBefore;
          store.authzBumps = bumpsBefore;
          store.updates.length = updatesBefore;
          store.cursors = cursorsBefore;
        }
        throw error;
      } finally {
        openTx -= 1;
      }
    },
  } as unknown as Db;
}

/** A staff user locked after failed sign-ins whose lock ended `endedAgoMs` before NOW (negative = still running). */
function lockedUser(id: string, endedAgoMs = 60_000, zitadelId = `z-${id}`) {
  store.users.push({
    id,
    tenantId: TENANT,
    idpOrgId: STAFF_IDP,
    zitadelUserId: zitadelId,
    email: `${id.slice(-3)}@techrida.test`,
    displayName: 'Mina Gurung',
    status: 'inactive',
    lockReason: 'failed_sign_ins',
    lockedUntil: new Date(NOW.getTime() - endedAgoMs).toISOString(),
  });
  zitadel.users.set(zitadelId, zUser(zitadelId, { status: 'inactive', locked: true }));
}

const row = (id: string) => store.users.find((u) => u.id === id);

beforeEach(() => {
  store = new FakeUsersStore();
  zitadel = new LockZitadel();
  audit = { record: vi.fn(() => Promise.resolve()) };
  actors = [];
  openTx = 0;
  failCommit = null;
  locks = new UserLocks(
    recordingDb(),
    store,
    zitadel as unknown as ZitadelAdminClient,
    audit as unknown as AuditService,
  );
  vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
});

describe('UserLocks.expire (F1-Q4)', () => {
  it('unlocks a due failed-sign-in lock in ZITADEL, then here, audited under the lock-expiry system actor', async () => {
    lockedUser(USER);

    expect(await locks.expire(NOW)).toEqual({ unlocked: 1, cleared: 0, postponed: 0 });

    expect(zitadel.unlockCalls).toEqual([`z-${USER}`]);
    expect(row(USER)).toMatchObject({ status: 'active', lockReason: null, lockedUntil: null });
    expect(store.authzBumps).toBe(1);
    expect(audit.record).toHaveBeenCalledWith(expect.anything(), {
      action: 'users.unlocked',
      entityType: 'users',
      entityId: USER,
      before: { status: 'inactive', lockReason: 'failed_sign_ins' },
      after: { status: 'active', lockReason: null },
      meta: { reason: 'lock_expired', lockedUntil: new Date(NOW.getTime() - 60_000).toISOString() },
    });
    expect(actors).toEqual(['system:users.lock-expiry']);
  });

  it('lets the only Founder back in too: ending a lock gives access back, so no Founder guard applies', async () => {
    lockedUser(USER);
    store.roles.set(USER, ['founder']);

    await locks.expire(NOW);

    expect(row(USER)).toMatchObject({ status: 'active', lockReason: null });
  });

  it('leaves a lock that is still running, and never touches an admin lock', async () => {
    lockedUser(USER, -60_000);
    store.users.push({
      id: OTHER,
      tenantId: TENANT,
      idpOrgId: STAFF_IDP,
      zitadelUserId: `z-${OTHER}`,
      email: null,
      displayName: 'Admin locked',
      status: 'inactive',
      lockReason: 'admin',
      lockedUntil: null,
    });

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

    expect(zitadel.unlockCalls).toEqual([]);
    expect(row(USER)?.lockReason).toBe('failed_sign_ins');
    expect(row(OTHER)?.lockReason).toBe('admin');
  });

  it('only mirrors a person ZITADEL no longer holds locked (unlocked or deactivated in the console meanwhile)', async () => {
    lockedUser(USER);
    lockedUser(OTHER);
    zitadel.users.set(`z-${USER}`, zUser(`z-${USER}`));
    zitadel.users.set(`z-${OTHER}`, zUser(`z-${OTHER}`, { status: 'inactive' }));

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 2, postponed: 0 });

    expect(zitadel.unlockCalls).toEqual([]);
    expect(row(USER)).toMatchObject({ status: 'active', lockReason: null });
    expect(row(OTHER)).toMatchObject({ status: 'inactive', lockReason: null });
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('postpones a lock ZITADEL refused to end by one window, so it is not retried every minute', async () => {
    lockedUser(USER);
    zitadel.failUnlock = new ZitadelHttpError('/UnlockUser', 400, 'failed_precondition');

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 1 });
    expect(row(USER)).toMatchObject({
      status: 'inactive',
      lockReason: 'failed_sign_ins',
      lockedUntil: new Date(NOW.getTime() + WINDOW_MS).toISOString(),
    });

    zitadel.failUnlock = null;
    expect(await locks.expire(new Date(NOW.getTime() + 60_000))).toEqual({
      unlocked: 0,
      cleared: 0,
      postponed: 0,
    });
    expect(await locks.expire(new Date(NOW.getTime() + WINDOW_MS))).toMatchObject({ unlocked: 1 });
  });

  it('postpones when ZITADEL cannot be read, and one failing lock does not stop the others', async () => {
    lockedUser(USER, 120_000);
    lockedUser(OTHER, 60_000);
    const getUser = zitadel.getUser.bind(zitadel);
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) =>
      id === `z-${USER}` ? Promise.reject(new Error('ZITADEL 503')) : getUser(id),
    );

    expect(await locks.expire(NOW)).toEqual({ unlocked: 1, cleared: 0, postponed: 1 });

    expect(row(USER)?.lockReason).toBe('failed_sign_ins');
    expect(row(OTHER)).toMatchObject({ status: 'active', lockReason: null });
  });

  it('calls ZITADEL with no transaction open, so a slow ZITADEL holds no connection or row lock', async () => {
    lockedUser(USER);
    lockedUser(OTHER);
    const getUser = zitadel.getUser.bind(zitadel);
    vi.spyOn(zitadel, 'getUser').mockImplementation((id: string) =>
      id === `z-${OTHER}` ? Promise.reject(new Error('ZITADEL 503')) : getUser(id),
    );

    expect(await locks.expire(NOW)).toEqual({ unlocked: 1, cleared: 0, postponed: 1 });

    expect(zitadel.unlockCalls).toEqual([`z-${USER}`]);
    expect(zitadel.callsInTx).toEqual([]);
  });

  it('keeps an admin lock that replaced the timed one while ZITADEL was unlocking: locked again there, nothing written here', async () => {
    lockedUser(USER);
    // The admin's lock under a failed-sign-in lock writes only here; ZITADEL is expected to hold the person locked.
    zitadel.duringUnlock = () => {
      const target = store.users.find((u) => u.id === USER)!;
      void store.updateUser({} as DbTransaction, USER, {
        email: target.email,
        displayName: target.displayName,
        status: 'inactive',
        lock: { reason: 'admin', lockedAt: NOW, until: null },
      });
    };

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

    expect(row(USER)).toMatchObject({ status: 'inactive', lockReason: 'admin', lockedUntil: null });
    expect(zitadel.lockCalls).toEqual([`z-${USER}`]);
    expect(zitadel.users.get(`z-${USER}`)).toMatchObject({ status: 'inactive', locked: true });
    expect(audit.record).not.toHaveBeenCalled();
    expect(store.authzBumps).toBe(0);
  });

  describe('fails closed when the write here does not go through after ZITADEL was unlocked', () => {
    class LockNotAvailable extends Error {
      override readonly name = 'LockNotAvailable';
    }
    class ZitadelDown extends Error {
      override readonly name = 'ZitadelDown';
    }
    /** The row lock times out (55P03 behind an admin action), before anything is written here. */
    function rowLockTimesOut() {
      const real = store.findById.bind(store);
      vi.spyOn(store, 'findById').mockImplementation((q, s, id, lock) =>
        lock === true ? Promise.reject(new LockNotAvailable('lock timeout')) : real(q, s, id, lock),
      );
    }
    const errorLines = () =>
      vi.mocked(Logger.prototype.error).mock.calls.map((call) => String(call[0]));

    it('locks ZITADEL again and logs the original error (old code: ZITADEL left unlocked)', async () => {
      lockedUser(USER);
      rowLockTimesOut();

      expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

      expect(zitadel.unlockCalls).toEqual([`z-${USER}`]);
      expect(zitadel.lockCalls).toEqual([`z-${USER}`]);
      expect(zitadel.users.get(`z-${USER}`)).toMatchObject({ status: 'inactive', locked: true });
      expect(row(USER)).toMatchObject({ status: 'inactive', lockReason: 'failed_sign_ins' });
      expect(errorLines()).toEqual([`users.lock-expiry failed for ${USER}: kind=LockNotAvailable`]);
      expect(zitadel.callsInTx).toEqual([]);
    });

    it('retries the re-lock, logs its failure with the user id, and still logs the original error', async () => {
      lockedUser(USER);
      rowLockTimesOut();
      zitadel.failLock = new ZitadelDown('503');

      expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

      expect(zitadel.lockAttempts).toBe(3);
      const lines = errorLines();
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain(`could not lock ${USER} again in ZITADEL`);
      expect(lines[0]).toContain('kind=LockNotAvailable');
      expect(lines[0]).toContain('kind=ZitadelDown');
      expect(lines[1]).toBe(`users.lock-expiry failed for ${USER}: kind=LockNotAvailable`);
    });

    it('locks ZITADEL again when the row cannot be read afterwards either', async () => {
      lockedUser(USER);
      vi.spyOn(store, 'findById').mockImplementation((_q, s, id, lock) => {
        const found = store.users.find((u) => u.id === id && u.tenantId === s.tenantId);
        // The first read (before ZITADEL) works; everything after it fails.
        if (lock !== true && zitadel.unlockCalls.length === 0) {
          return Promise.resolve(found ? { ...found, version: '0' } : null);
        }
        return Promise.reject(new LockNotAvailable('database gone'));
      });

      await locks.expire(NOW);

      expect(zitadel.lockCalls).toEqual([`z-${USER}`]);
    });

    it('rolls back and locks ZITADEL again when a later write in the same transaction fails (audit error)', async () => {
      lockedUser(USER);
      audit.record.mockRejectedValueOnce(new ZitadelDown('audit failed'));

      expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

      expect(row(USER)).toMatchObject({ status: 'inactive', lockReason: 'failed_sign_ins' });
      expect(store.authzBumps).toBe(0);
      expect(zitadel.lockCalls).toEqual([`z-${USER}`]);
      expect(zitadel.users.get(`z-${USER}`)).toMatchObject({ status: 'inactive', locked: true });
    });

    it('does not lock ZITADEL again when the commit went through and only the answer was lost', async () => {
      lockedUser(USER);
      failCommit = new ZitadelDown('connection dropped after commit');

      await locks.expire(NOW);

      expect(row(USER)).toMatchObject({ status: 'active', lockReason: null });
      expect(zitadel.lockAttempts).toBe(0);
    });
  });

  it('writes nothing and leaves ZITADEL unlocked when an admin unlocked the person meanwhile', async () => {
    lockedUser(USER);
    zitadel.duringUnlock = () => {
      const target = store.users.find((u) => u.id === USER)!;
      void store.updateUser({} as DbTransaction, USER, {
        email: target.email,
        displayName: target.displayName,
        status: 'active',
        lock: null,
      });
    };

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

    expect(row(USER)).toMatchObject({ status: 'active', lockReason: null });
    expect(zitadel.lockCalls).toEqual([]);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('still ends the lock when only the name changed meanwhile, and keeps the new name', async () => {
    lockedUser(USER);
    zitadel.duringUnlock = () => {
      store.users.find((u) => u.id === USER)!.displayName = 'Mina Gurung-Rai';
    };

    expect(await locks.expire(NOW)).toEqual({ unlocked: 1, cleared: 0, postponed: 0 });

    expect(row(USER)).toMatchObject({
      status: 'active',
      lockReason: null,
      displayName: 'Mina Gurung-Rai',
    });
    expect(zitadel.lockCalls).toEqual([]);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it('stops without changing anything when no provisioner token is configured', async () => {
    lockedUser(USER);
    zitadel.failGetUser = new ZitadelNotConfiguredError();

    expect(await locks.expire(NOW)).toEqual({ unlocked: 0, cleared: 0, postponed: 0 });

    expect(row(USER)).toMatchObject({
      lockReason: 'failed_sign_ins',
      lockedUntil: new Date(NOW.getTime() - 60_000).toISOString(),
    });
  });
});

describe('UserLocks.ensureLockoutPolicies (F1-Q4)', () => {
  it("pins ACCOUNT_LOCKOUT's attempt limits on every staff org and audits a change", async () => {
    await locks.ensureLockoutPolicies();

    expect(zitadel.policyCalls).toEqual([
      {
        orgId: STAFF_ZORG,
        want: {
          maxPasswordAttempts: ACCOUNT_LOCKOUT.maxPasswordAttempts,
          maxOtpAttempts: ACCOUNT_LOCKOUT.maxOtpAttempts,
        },
      },
    ]);
    expect(audit.record).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        action: 'users.lockout_policy_pinned',
        entityType: 'idp_orgs',
        entityId: STAFF_IDP,
      }),
    );
    expect(actors).toEqual(['system:users.lockout-policy']);
  });

  it('writes no audit row when the policy already matches', async () => {
    zitadel.policyAnswer = 'unchanged';

    await locks.ensureLockoutPolicies();

    expect(audit.record).not.toHaveBeenCalled();
  });

  it('logs a failed org as an error saying the lockout is off, and never throws', async () => {
    zitadel.policyAnswer = new ZitadelHttpError('/management/v1/policies/lockout', 403, 'denied');
    const error = vi.spyOn(Logger.prototype, 'error');

    await expect(locks.ensureLockoutPolicies()).resolves.toBeUndefined();

    expect(error).toHaveBeenCalledWith(expect.stringContaining('sign-in lockout is OFF'));
    expect(audit.record).not.toHaveBeenCalled();
  });
});

describe('UserLocks records when the lockout policy was pinned (P2-1)', () => {
  it('stores the first time the policy is in place on an org and keeps it on later passes', async () => {
    const before = Date.now();
    await locks.ensureLockoutPolicies();
    const first = store.cursors.get(lockoutPinnedCursor(STAFF_ZORG));
    expect(Date.parse(first ?? '')).toBeGreaterThanOrEqual(before);

    zitadel.policyAnswer = 'unchanged';
    await new Promise((resolve) => setTimeout(resolve, 5));
    await locks.ensureLockoutPolicies();

    expect(store.cursors.get(lockoutPinnedCursor(STAFF_ZORG))).toBe(first);
  });

  it('stores it for a policy already in place (unchanged) when none is stored yet', async () => {
    zitadel.policyAnswer = 'unchanged';

    await locks.ensureLockoutPolicies();

    expect(store.cursors.get(lockoutPinnedCursor(STAFF_ZORG))).toBeDefined();
  });

  it('stores nothing while the policy could not be pinned', async () => {
    zitadel.policyAnswer = new ZitadelHttpError('/management/v1/policies/lockout', 403, 'denied');

    await locks.ensureLockoutPolicies();

    expect(store.cursors.has(lockoutPinnedCursor(STAFF_ZORG))).toBe(false);
  });
});

describe('R6C1: UserLocks.expire under the tenant lease', () => {
  const none = { unlocked: 0, cleared: 0, postponed: 0 };

  it('(g) holds the tenant lease while it unlocks, and leaves a due lock while another change holds it', async () => {
    lockedUser(USER);
    store.founderLeases.set(TENANT, 'other-change');
    expect(await locks.expire(NOW)).toEqual(none);
    expect(zitadel.unlockCalls).toEqual([]);
    expect(row(USER)).toMatchObject({ lockReason: 'failed_sign_ins' });
    store.founderLeases.delete(TENANT);

    const held: boolean[] = [];
    zitadel.duringUnlock = () => held.push(store.founderLeases.has(TENANT));
    expect(await locks.expire(NOW)).toMatchObject({ unlocked: 1 });
    expect(held).toEqual([true]);
    expect(store.founderLeases.has(TENANT)).toBe(false);
  });

  it('(d) a busy lock (55P03) while writing is contention: warned, not an error, and the person is locked again', async () => {
    lockedUser(USER);
    const busy = Object.assign(new Error('lock timeout'), { code: '55P03' });
    const real = store.findById.bind(store);
    vi.spyOn(store, 'findById').mockImplementation((q, s, id, lock) =>
      lock === true ? Promise.reject(busy) : real(q, s, id, lock),
    );

    expect(await locks.expire(NOW)).toEqual(none);

    expect(vi.mocked(Logger.prototype.error).mock.calls).toEqual([]);
    expect(zitadel.lockCalls).toEqual([`z-${USER}`]);
    expect(row(USER)).toMatchObject({ lockReason: 'failed_sign_ins' });
  });
});
