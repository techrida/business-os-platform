// The BullMQ side of the outbox drain. Serves the Reliability NFR (Non-Functional Requirement: a measurable
// quality target): a repeating job drains the outbox every 5 s even if nobody nudges it, so a lost nudge
// delays an email by seconds instead of losing it.
import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';

import { OUTBOX_DRAIN_JOB, OUTBOX_QUEUE } from './notify.constants';
import { OutboxDrainer } from './outbox.drainer';

/** The backstop schedule. NotifyService.nudge() adds an extra job right after a commit for low latency. */
export const OUTBOX_DRAIN_SCHEDULER_ID = 'outbox.drain.every-5s';
export const OUTBOX_DRAIN_EVERY_MS = 5000;

/** Runs one drain pass per job. Worker concurrency is 1, so passes of one worker never overlap. */
@Processor(OUTBOX_QUEUE)
export class OutboxProcessor extends WorkerHost {
  private readonly logger = new Logger(OutboxProcessor.name);

  constructor(private readonly drainer: OutboxDrainer) {
    super();
  }

  async process(job: Job): Promise<void> {
    if (job.name !== OUTBOX_DRAIN_JOB) {
      // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
      throw new Error(`Unknown outbox job: ${job.name}`);
    }
    const r = await this.drainer.drainOnce();
    // Quiet when idle: this runs every 5 s and an empty pass is the normal case.
    if (r.claimed > 0 || r.dead > 0) {
      this.logger.log(
        `outbox drain: claimed ${r.claimed}, sent ${r.sent}, failed ${r.failed}, dead ${r.dead}`,
      );
    }
  }
}

/**
 * Registers the repeating drain job at startup. `upsertJobScheduler` is idempotent: restarting the worker
 * (or running two) updates the one schedule instead of stacking duplicates.
 */
@Injectable()
export class OutboxDrainScheduler implements OnModuleInit {
  constructor(@InjectQueue(OUTBOX_QUEUE) private readonly queue: Queue) {}

  async onModuleInit(): Promise<void> {
    await this.queue.upsertJobScheduler(
      OUTBOX_DRAIN_SCHEDULER_ID,
      { every: OUTBOX_DRAIN_EVERY_MS },
      { name: OUTBOX_DRAIN_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
