import { InjectQueue, Processor, WorkerHost } from '@nestjs/bullmq';
import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { type Job, Queue } from 'bullmq';

import { MetricsService } from '../obs/metrics.service';
import { HEARTBEAT_INTERVAL_MS, HEARTBEAT_JOB, SYSTEM_QUEUE } from './queue.constants';

/**
 * Handles `system.*` jobs. The heartbeat proves the whole path works: Valkey accepted the
 * schedule, a worker took the job and the process can still do work. It sets the gauge
 * `worker_last_heartbeat_seconds`, which the worker's /health also reads.
 */
@Processor(SYSTEM_QUEUE)
export class SystemProcessor extends WorkerHost {
  private readonly logger = new Logger(SystemProcessor.name);

  constructor(private readonly metrics: MetricsService) {
    super();
  }

  process(job: Job): Promise<void> {
    if (job.name === HEARTBEAT_JOB) {
      this.metrics.recordHeartbeat(Date.now() / 1000);
      this.logger.log('worker heartbeat');
      return Promise.resolve();
    }
    // A job name nobody handles is a bug; failing keeps it visible instead of silently dropping it.
    return Promise.reject(new Error(`Unknown system job: ${job.name}`));
  }
}

/**
 * Registers the repeating heartbeat at startup. `upsertJobScheduler` is idempotent: restarting
 * the worker (or running two) updates the one schedule instead of stacking duplicates.
 */
@Injectable()
export class HeartbeatScheduler implements OnApplicationBootstrap {
  constructor(@InjectQueue(SYSTEM_QUEUE) private readonly queue: Queue) {}

  async onApplicationBootstrap(): Promise<void> {
    await this.queue.upsertJobScheduler(
      HEARTBEAT_JOB,
      { every: HEARTBEAT_INTERVAL_MS },
      { name: HEARTBEAT_JOB, opts: { removeOnComplete: 5, removeOnFail: 20 } },
    );
  }
}
