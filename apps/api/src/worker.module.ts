import { Module } from '@nestjs/common';

import { ConfigModule } from './platform/config/config.module';
import { DbModule } from './platform/db/db.module';
import { ObsModule } from './platform/obs/obs.module';
import { QueueModule } from './platform/queue/queue.module';
import { HeartbeatScheduler, SystemProcessor } from './platform/queue/system.processor';
import { WorkerHealth } from './platform/queue/worker-health';

/**
 * The BullMQ worker: no HTTP router, no auth. The processor and the heartbeat schedule live
 * here and not in QueueModule, so the API process never consumes jobs.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ service: 'worker' }),
    ObsModule.forRoot({ service: 'worker' }),
    DbModule,
    QueueModule,
  ],
  providers: [SystemProcessor, HeartbeatScheduler, WorkerHealth],
})
export class WorkerModule {}
