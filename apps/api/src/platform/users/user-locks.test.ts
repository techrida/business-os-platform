// Unit tests of the timed sign-in lock's worker half (F1-Q4): the lock-expiry job and the lockout-policy pinning. The
// store and ZITADEL are fakes; the SQL half of expiredLocks and the lock columns is in admin-users.test.ts (Docker).
import { ACCOUNT_LOCKOUT } from '@bos/contracts';
import { Logger } from '@nestjs/common';
import type { SQL } from 'drizzle-orm';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { AuditService } from '../audit/audit.service';
import type { Db, DbTransaction } from '../db/db.module';
import { UserLocks } from './user-locks';
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
  failUnlock: Error | null = null;
  failGetUser: Error | null = null;
  policyCalls: { orgId: string; want: OrgLockoutPolicy }[] = [];
  policyAnswer: 'created' | 'updated' | 'unchanged' | Error = 'created';

  getUser(id: string) {
    if (this.failGetUser) return Promise.reject(this.failGetUser);
    return Promise.resolve(this.users.get(id) ?? null);
  }
  unlockUser(id: string) {
    if (this.failUnlock) return Promise.reject(this.failUnlock);
    this.unlockCalls.push(id);
    const user = this.users.get(id);
    if (user) Object.assign(user, { status: 'active', locked: false });
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
  return { transaction: <T>(fn: (t: DbTransaction) => Promise<T>) => fn(tx) } as unknown as Db;
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
