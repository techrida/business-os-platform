// The users queue's job routing (F1-Q4): the lock-expiry job runs UserLocks.expire, a reconcile pins the lockout
// policy before it walks the orgs, and the scheduler registers both repeatable jobs.
import { Logger } from '@nestjs/common';
import type { Job, Queue } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';

import type { UserLocks } from './user-locks';
import type { UserMirror } from './user-mirror';
import {
  USERS_LOCK_EXPIRY_EVERY_MS,
  USERS_LOCK_EXPIRY_JOB,
  USERS_RECONCILE_EVERY_MS,
  USERS_RECONCILE_JOB,
  type UsersSyncData,
} from './users.constants';
import { UsersProcessor, UsersReconcileScheduler } from './users.processor';

function processor() {
  const order: string[] = [];
  const mirror = {
    reconcile: vi.fn(() => {
      order.push('reconcile');
      return Promise.resolve({ scanned: 0, changed: 0 });
    }),
  };
  const locks = {
    expire: vi.fn(() => Promise.resolve({ unlocked: 1, cleared: 0, postponed: 0 })),
    ensureLockoutPolicies: vi.fn(() => {
      order.push('policy');
      return Promise.resolve();
    }),
  };
  vi.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  const p = new UsersProcessor(mirror as unknown as UserMirror, locks as unknown as UserLocks);
  const run = (name: string) => p.process({ name, data: {} } as Job<UsersSyncData>);
  return { run, mirror, locks, order };
}

describe('UsersProcessor', () => {
  it('runs the lock expiry on its own job', async () => {
    const { run, locks, mirror } = processor();

    await expect(run(USERS_LOCK_EXPIRY_JOB)).resolves.toEqual({
      unlocked: 1,
      cleared: 0,
      postponed: 0,
    });
    expect(locks.expire).toHaveBeenCalledOnce();
    expect(mirror.reconcile).not.toHaveBeenCalled();
  });

  it('pins the lockout policy before each reconcile pass', async () => {
    const { run, order } = processor();

    await run(USERS_RECONCILE_JOB);

    expect(order).toEqual(['policy', 'reconcile']);
  });

  it('registers the reconcile and the one-minute lock expiry as repeatable jobs', async () => {
    const upsertJobScheduler = vi.fn(() => Promise.resolve());
    const scheduler = new UsersReconcileScheduler({ upsertJobScheduler } as unknown as Queue);

    await scheduler.onApplicationBootstrap();

    expect(upsertJobScheduler).toHaveBeenCalledWith(
      USERS_RECONCILE_JOB,
      { every: USERS_RECONCILE_EVERY_MS },
      expect.anything(),
    );
    expect(upsertJobScheduler).toHaveBeenCalledWith(
      USERS_LOCK_EXPIRY_JOB,
      { every: USERS_LOCK_EXPIRY_EVERY_MS },
      expect.objectContaining({ name: USERS_LOCK_EXPIRY_JOB }),
    );
  });
});
