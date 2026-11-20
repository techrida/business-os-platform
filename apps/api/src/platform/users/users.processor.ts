// Worker side of k-users: the `users` queue's jobs, the 10-minute reconcile schedule and the one-minute lock expiry
// (F1-Q4). Each reconcile run first pins the sign-in lockout policy on the staff orgs.
// Serves the NFR "a lost webhook is repaired within 10 minutes": restAsync has no documented retry,
// so the repeatable reconcile is what makes the mirror eventually correct.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';

import { UserLocks } from './user-locks';
import { UserMirror } from './user-mirror';
import {
  USERS_LOCK_EXPIRY_EVERY_MS,
  USERS_LOCK_EXPIRY_JOB,
  USERS_QUEUE,
  USERS_RECONCILE_EVERY_MS,
  USERS_RECONCILE_JOB,
  USERS_SYNC_JOB,
  type UsersSyncData,
} from './users.constants';

@Processor(USERS_QUEUE)
export class UsersProcessor extends WorkerHost {
  private readonly logger = new Logger(UsersProcessor.name);

  constructor(
    private readonly mirror: UserMirror,
    private readonly locks: UserLocks,
  ) {
    super();
  }

  async process(job: Job<UsersSyncData>): Promise<unknown> {
    if (job.name === USERS_SYNC_JOB) {
      const changed = await this.mirror.syncUser(job.data.zitadelUserId);
      return { changed };
    }
    if (job.name === USERS_LOCK_EXPIRY_JOB) {
      const result = await this.locks.expire();
      if (result.unlocked + result.cleared + result.postponed > 0) {
        this.logger.log(
          `users.lock-expiry unlocked=${result.unlocked} cleared=${result.cleared} postponed=${result.postponed}`,
        );
      }
      return result;
    }
    if (job.name === USERS_RECONCILE_JOB) {
      await this.locks.ensureLockoutPolicies();
      const result = await this.mirror.reconcile();
      this.logger.log(`users.reconcile scanned=${result.scanned} changed=${result.changed}`);
      return result;
    }
    // An unknown job name is a bug; failing keeps it visible.
    throw new Error(`Unknown users job: ${job.name}`);
  }
}

/** Registers the repeatable reconcile and lock expiry. upsertJobScheduler is idempotent across restarts and replicas. */
@Injectable()
export class UsersReconcileScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(USERS_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      USERS_RECONCILE_JOB,
      { every: USERS_RECONCILE_EVERY_MS },
      { name: USERS_RECONCILE_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
    await this.queue.upsertJobScheduler(
      USERS_LOCK_EXPIRY_JOB,
      { every: USERS_LOCK_EXPIRY_EVERY_MS },
      { name: USERS_LOCK_EXPIRY_JOB, opts: { removeOnComplete: 10, removeOnFail: 50 } },
    );
  }
}
